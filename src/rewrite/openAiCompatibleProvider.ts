import { z } from 'zod';

import {
  DEFAULT_REWRITE_OPTIONS,
  type RewriteOptions,
  type RewriteProviderResult,
} from './contracts';
import { createRewriteSystemPrompt } from './prompt';

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

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

const modelsPayloadSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

export type RewriteProviderErrorCode =
  | 'PROVIDER_CANCELLED'
  | 'PROVIDER_CONFIGURATION_ERROR'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE';

export type RewriteTransportFailureKind = 'invalid_header' | 'network' | 'other';

export class RewriteProviderError extends Error {
  constructor(
    readonly code: RewriteProviderErrorCode,
    readonly statusCode?: number,
    readonly transportFailureKind?: RewriteTransportFailureKind,
    readonly diagnosticStatusCode?: number,
    readonly diagnosticModelAvailable?: boolean,
  ) {
    super(code);
    this.name = 'RewriteProviderError';
  }
}

interface OpenAiCompatibleProviderOptions {
  apiKey: string;
  baseUrl: string;
  enableConnectivityProbe?: boolean;
  fetch?: typeof fetch;
  model: string;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export class OpenAiCompatibleProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly enableConnectivityProbe: boolean;
  private readonly fetchImplementation: typeof fetch;
  private readonly model: string;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.apiKey = options.apiKey.trim();

    if (!/^[\x21-\x7e]+$/u.test(this.apiKey)) {
      throw new RewriteProviderError('PROVIDER_CONFIGURATION_ERROR');
    }

    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.enableConnectivityProbe = options.enableConnectivityProbe ?? false;
    this.fetchImplementation = options.fetch ?? fetch;
    this.model = options.model;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async rewrite(
    text: string,
    options: RewriteOptions = DEFAULT_REWRITE_OPTIONS,
    cancellationSignal?: AbortSignal,
  ): Promise<RewriteProviderResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.requestProviderApi(text, options, cancellationSignal);

      if (response.ok) {
        return this.parseChatCompletionsResult(response);
      }

      if (attempt === 0 && RETRYABLE_STATUS_CODES.has(response.status)) {
        await waitForRetry(this.retryDelayMs, cancellationSignal);
        continue;
      }

      if (response.status === 429) {
        throw new RewriteProviderError('PROVIDER_RATE_LIMITED', response.status);
      }

      if (response.status >= 500) {
        throw new RewriteProviderError('PROVIDER_UNAVAILABLE', response.status);
      }

      throw new RewriteProviderError('PROVIDER_REJECTED', response.status);
    }

    throw new RewriteProviderError('PROVIDER_UNAVAILABLE');
  }

  private async requestProviderApi(
    text: string,
    options: RewriteOptions,
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
      const request = {
        body: {
          messages: [
            { content: createRewriteSystemPrompt(options), role: 'system' },
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
        throw new RewriteProviderError('PROVIDER_CANCELLED');
      }

      if (didTimeout) {
        throw new RewriteProviderError('PROVIDER_TIMEOUT');
      }

      const diagnostic = this.enableConnectivityProbe
        ? await this.probeProviderAccess()
        : undefined;

      throw new RewriteProviderError(
        'PROVIDER_UNAVAILABLE',
        undefined,
        classifyTransportFailure(error),
        diagnostic?.statusCode,
        diagnostic?.modelAvailable,
      );
    } finally {
      clearTimeout(timeout);
      cancellationSignal?.removeEventListener('abort', cancelRequest);
    }
  }

  private async probeProviderAccess(): Promise<{
    modelAvailable?: boolean;
    statusCode?: number;
  }> {
    try {
      const response = await this.fetchImplementation(`${this.baseUrl}/v1/models`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5_000)),
      });

      if (!response.ok) {
        return { statusCode: response.status };
      }

      const payload = await response.json().catch(() => null);
      const parsedPayload = modelsPayloadSchema.safeParse(payload);

      return {
        modelAvailable: parsedPayload.success
          ? parsedPayload.data.data.some((model) => model.id === this.model)
          : undefined,
        statusCode: response.status,
      };
    } catch {
      return {};
    }
  }

  private async parseChatCompletionsResult(response: Response): Promise<RewriteProviderResult> {
    const payload = await response.json().catch(() => null);
    const parsedPayload = chatCompletionsPayloadSchema.safeParse(payload);

    if (!parsedPayload.success) {
      throw new RewriteProviderError('PROVIDER_INVALID_RESPONSE');
    }

    const rewrittenText = parsedPayload.data.choices[0]?.message.content.trim();

    if (!rewrittenText) {
      throw new RewriteProviderError('PROVIDER_INVALID_RESPONSE');
    }

    return {
      inputTokens: parsedPayload.data.usage.prompt_tokens,
      outputTokens: parsedPayload.data.usage.completion_tokens,
      text: rewrittenText,
    };
  }
}

function classifyTransportFailure(error: unknown): RewriteTransportFailureKind {
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
    throw new RewriteProviderError('PROVIDER_CANCELLED');
  }

  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const cancelRetry = () => {
      clearTimeout(timeout);
      reject(new RewriteProviderError('PROVIDER_CANCELLED'));
    };
    const finishRetryDelay = () => {
      cancellationSignal?.removeEventListener('abort', cancelRetry);
      resolve();
    };
    const timeout = setTimeout(finishRetryDelay, delayMs);

    cancellationSignal?.addEventListener('abort', cancelRetry, { once: true });
  });
}
