import { describe, expect, it, vi } from 'vitest';

import {
  OpenAiCompatibleProvider,
  RewriteProviderError,
} from '../../src/rewrite/openAiCompatibleProvider';
import {
  createRewriteSystemPrompt,
  REWRITE_PROMPT_VERSION,
  REWRITE_SYSTEM_PROMPT,
} from '../../src/rewrite/prompt';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

describe('OpenAI-compatible rewrite provider', () => {
  it('rewrites through Wenwen Chat Completions with complete usage', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'Chat response.' } }],
        usage: { completion_tokens: 7, prompt_tokens: 18 },
      }),
    );
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'provider-secret',
      baseUrl: 'https://breakout.wenwen-ai.com',
      fetch: fetchMock,
      model: 'gpt-5.5',
      retryDelayMs: 0,
      timeoutMs: 1_000,
    });

    await expect(provider.rewrite('Original.')).resolves.toEqual({
      inputTokens: 18,
      outputTokens: 7,
      text: 'Chat response.',
    });

    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://breakout.wenwen-ai.com/v1/chat/completions');
    expect(JSON.parse(String(request?.body))).toEqual({
      messages: [
        { content: REWRITE_SYSTEM_PROMPT, role: 'system' },
        { content: 'Original.', role: 'user' },
      ],
      model: 'gpt-5.5',
      stream: false,
    });
    expect(REWRITE_PROMPT_VERSION).toBe('rewrite-v1.1.0');
  });

  it('calls the runtime fetch implementation with the global receiver', async () => {
    const receiverSensitiveFetch = vi.fn(function (this: unknown): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation: incorrect this reference');
      }

      return Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: 'Runtime-compatible response.' } }],
          usage: { completion_tokens: 5, prompt_tokens: 14 },
        }),
      );
    });
    vi.stubGlobal('fetch', receiverSensitiveFetch);

    try {
      const provider = new OpenAiCompatibleProvider({
        apiKey: 'provider-secret',
        baseUrl: 'https://breakout.wenwen-ai.com',
        model: 'gpt-5.5',
        retryDelayMs: 0,
        timeoutMs: 1_000,
      });

      await expect(provider.rewrite('Original.')).resolves.toMatchObject({
        text: 'Runtime-compatible response.',
      });
      expect(receiverSensitiveFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('puts selected rewrite controls into the provider instructions without a language override', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'A concise professional result.' } }],
        usage: { completion_tokens: 4, prompt_tokens: 12 },
      }),
    );
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'provider-secret',
      baseUrl: 'https://breakout.wenwen-ai.com',
      fetch: fetchMock,
      model: 'gpt-5.5',
      retryDelayMs: 0,
      timeoutMs: 1_000,
    });
    const options = {
      formality: 'high' as const,
      strength: 'low' as const,
      tone: 'concise' as const,
    };

    await provider.rewrite('Original text.', options);

    const request = fetchMock.mock.calls[0]?.[1];
    const requestBody = JSON.parse(String(request?.body));
    expect(requestBody.messages[0]).toEqual({
      content: createRewriteSystemPrompt(options),
      role: 'system',
    });
    expect(requestBody).not.toHaveProperty('language');
  });

  it('retries one explicitly retryable HTTP failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'temporary' } }, 503))
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: 'Recovered.' } }],
          usage: { completion_tokens: 8, prompt_tokens: 20 },
        }),
      );
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'provider-secret',
      baseUrl: 'https://breakout.wenwen-ai.com',
      fetch: fetchMock,
      model: 'gpt-5.5',
      retryDelayMs: 0,
      timeoutMs: 1_000,
    });

    await expect(provider.rewrite('Original.')).resolves.toMatchObject({ text: 'Recovered.' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps only the safe upstream status after retries are exhausted', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: { message: 'sensitive provider detail' } }, 503));
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'provider-secret',
      baseUrl: 'https://breakout.wenwen-ai.com',
      fetch: fetchMock,
      model: 'gpt-5.5',
      retryDelayMs: 0,
      timeoutMs: 1_000,
    });

    const error = await provider.rewrite('Original.').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RewriteProviderError);
    expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', statusCode: 503 });
    expect(String(error)).not.toContain('sensitive provider detail');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('times out without retrying an ambiguous provider request', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'provider-secret',
      baseUrl: 'https://breakout.wenwen-ai.com',
      fetch: fetchMock,
      model: 'gpt-5.5',
      retryDelayMs: 0,
      timeoutMs: 5,
    });

    await expect(provider.rewrite('Original.')).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('classifies transport failures without retaining raw error messages', async () => {
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'provider-secret',
      baseUrl: 'https://breakout.wenwen-ai.com',
      fetch: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new TypeError('fetch failed with sensitive runtime details')),
      model: 'gpt-5.5',
      retryDelayMs: 0,
      timeoutMs: 1_000,
    });

    const error = await provider.rewrite('Original.').catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      transportFailureKind: 'network',
    });
    expect(String(error)).not.toContain('sensitive runtime details');
  });

  it('honors caller cancellation without starting another request', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'provider-secret',
      baseUrl: 'https://breakout.wenwen-ai.com',
      fetch: fetchMock,
      model: 'gpt-5.5',
      retryDelayMs: 0,
      timeoutMs: 1_000,
    });
    const controller = new AbortController();
    const result = provider.rewrite('Original.', undefined, controller.signal);
    controller.abort();

    await expect(result).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
