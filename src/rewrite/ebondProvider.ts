import { z } from 'zod';

import type { RewriteProviderResult } from './contracts';
import { REWRITE_SYSTEM_PROMPT } from './prompt';

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

const responsesPayloadSchema = z
  .object({
    output_text: z.string().optional(),
    output: z
      .array(
        z
          .object({
            content: z
              .array(
                z
                  .object({
                    text: z.string().optional(),
                    type: z.string(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    usage: z.object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    }),
  })
  .passthrough();

const chatCompletionsPayloadSchema = z
  .object({
    choices: z
      .array(
        z.object({
          message: z.object({
            content: z.string(),
          }),
        }),
      )
      .min(1),
    usage: z.object({
      completion_tokens: z.number().int().nonnegative(),
      prompt_tokens: z.number().int().nonnegative(),
    }),
  })
  .passthrough();

export type EbondApiMode = 'chat_completions' | 'responses';

export type EbondProviderErrorCode =
  | 'PROVIDER_CANCELLED'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE';

export type EbondTransportFailureKind = 'invalid_header' | 'network' | 'other';

export class EbondProviderError extends Error {
  constructor(
    readonly code: EbondProviderErrorCode,
    readonly statusCode?: number,
    readonly transportFailureKind?: EbondTransportFailureKind,
  ) {
    super(code);
    this.name = 'EbondProviderError';
  }
}

interface EbondProviderOptions {
  apiKey: string;
  apiMode?: EbondApiMode;
  baseUrl: string;
  fetch?: typeof fetch;
  model: string;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export class EbondProvider {
  private readonly apiKey: string;
  private readonly apiMode: EbondApiMode;
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly model: string;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;

  constructor(options: EbondProviderOptions) {
    this.apiKey = options.apiKey.trim();
    this.apiMode = options.apiMode ?? 'responses';
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.fetchImplementation = options.fetch ?? fetch;
    this.model = options.model;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async rewrite(text: string, cancellationSignal?: AbortSignal): Promise<RewriteProviderResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.requestProviderApi(text, cancellationSignal);

      if (response.ok) {
        return this.apiMode === 'responses'
          ? this.parseResponsesResult(response)
          : this.parseChatCompletionsResult(response);
      }

      if (attempt === 0 && RETRYABLE_STATUS_CODES.has(response.status)) {
        await waitForRetry(this.retryDelayMs, cancellationSignal);
        continue;
      }

      if (response.status === 429) {
        throw new EbondProviderError('PROVIDER_RATE_LIMITED', response.status);
      }

      if (response.status >= 500) {
        throw new EbondProviderError('PROVIDER_UNAVAILABLE', response.status);
      }

      throw new EbondProviderError('PROVIDER_REJECTED', response.status);
    }

    throw new EbondProviderError('PROVIDER_UNAVAILABLE');
  }

  private async requestProviderApi(
    text: string,
    cancellationSignal?: AbortSignal,
  ): Promise<Response> {
    const requestController = new AbortController();
    let didTimeout = false;
    const cancelRequest = () => requestController.abort();
    const timeout = setTimeout(() => {
      didTimeout = true;
      requestController.abort();
    }, this.timeoutMs);

    cancellationSignal?.addEventListener('abort', cancelRequest, { once: true });

    if (cancellationSignal?.aborted) {
      cancelRequest();
    }

    try {
      const request =
        this.apiMode === 'responses'
          ? {
              body: {
                input: text,
                instructions: REWRITE_SYSTEM_PROMPT,
                model: this.model,
                store: false,
              },
              path: '/v1/responses',
            }
          : {
              body: {
                messages: [
                  { content: REWRITE_SYSTEM_PROMPT, role: 'system' },
                  { content: text, role: 'user' },
                ],
                model: this.model,
                stream: false,
              },
              path: '/v1/chat/completions',
            };

      return await this.fetchImplementation(`${this.baseUrl}${request.path}`, {
        body: JSON.stringify(request.body),
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        method: 'POST',
        signal: requestController.signal,
      });
    } catch (error) {
      if (cancellationSignal?.aborted) {
        throw new EbondProviderError('PROVIDER_CANCELLED');
      }

      if (didTimeout) {
        throw new EbondProviderError('PROVIDER_TIMEOUT');
      }

      throw new EbondProviderError(
        'PROVIDER_UNAVAILABLE',
        undefined,
        classifyTransportFailure(error),
      );
    } finally {
      clearTimeout(timeout);
      cancellationSignal?.removeEventListener('abort', cancelRequest);
    }
  }

  private async parseResponsesResult(response: Response): Promise<RewriteProviderResult> {
    const payload = await response.json().catch(() => null);
    const parsedPayload = responsesPayloadSchema.safeParse(payload);

    if (!parsedPayload.success) {
      throw new EbondProviderError('PROVIDER_INVALID_RESPONSE');
    }

    const nestedText = parsedPayload.data.output
      ?.flatMap((outputItem) => outputItem.content ?? [])
      .find((contentItem) => contentItem.type === 'output_text')?.text;
    const rewrittenText = (parsedPayload.data.output_text ?? nestedText)?.trim();

    if (!rewrittenText) {
      throw new EbondProviderError('PROVIDER_INVALID_RESPONSE');
    }

    return {
      inputTokens: parsedPayload.data.usage.input_tokens,
      outputTokens: parsedPayload.data.usage.output_tokens,
      text: rewrittenText,
    };
  }

  private async parseChatCompletionsResult(response: Response): Promise<RewriteProviderResult> {
    const payload = await response.json().catch(() => null);
    const parsedPayload = chatCompletionsPayloadSchema.safeParse(payload);

    if (!parsedPayload.success) {
      throw new EbondProviderError('PROVIDER_INVALID_RESPONSE');
    }

    const rewrittenText = parsedPayload.data.choices[0]?.message.content.trim();

    if (!rewrittenText) {
      throw new EbondProviderError('PROVIDER_INVALID_RESPONSE');
    }

    return {
      inputTokens: parsedPayload.data.usage.prompt_tokens,
      outputTokens: parsedPayload.data.usage.completion_tokens,
      text: rewrittenText,
    };
  }
}

function classifyTransportFailure(error: unknown): EbondTransportFailureKind {
  if (!(error instanceof Error)) {
    return 'other';
  }

  const normalizedMessage = error.message.toLowerCase();

  if (normalizedMessage.includes('header') || normalizedMessage.includes('bytestring')) {
    return 'invalid_header';
  }

  if (
    normalizedMessage.includes('fetch failed') ||
    normalizedMessage.includes('network') ||
    normalizedMessage.includes('connection')
  ) {
    return 'network';
  }

  return 'other';
}

async function waitForRetry(delayMs: number, cancellationSignal?: AbortSignal): Promise<void> {
  if (cancellationSignal?.aborted) {
    throw new EbondProviderError('PROVIDER_CANCELLED');
  }

  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, delayMs);
    const cancelRetry = () => {
      clearTimeout(timeout);
      reject(new EbondProviderError('PROVIDER_CANCELLED'));
    };

    cancellationSignal?.addEventListener('abort', cancelRetry, { once: true });
  });
}
