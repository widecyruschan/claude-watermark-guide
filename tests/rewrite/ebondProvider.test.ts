import { describe, expect, it, vi } from 'vitest';

import { EbondProvider, EbondProviderError } from '../../src/rewrite/ebondProvider';
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

describe('EBond Responses provider', () => {
  it('rewrites through the Responses API and returns complete usage', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Natural rewritten text.' }],
          },
        ],
        usage: { input_tokens: 120, output_tokens: 45 },
      }),
    );
    const provider = new EbondProvider({
      apiKey: '\nprovider-secret\n',
      baseUrl: 'https://api.ebondai.com/',
      fetch: fetchMock,
      model: 'gpt-5.5',
      retryDelayMs: 0,
      timeoutMs: 1_000,
    });

    await expect(provider.rewrite('Original text.')).resolves.toEqual({
      inputTokens: 120,
      outputTokens: 45,
      text: 'Natural rewritten text.',
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.ebondai.com/v1/responses');
    expect(request?.method).toBe('POST');
    expect(new Headers(request?.headers).get('authorization')).toBe('Bearer provider-secret');
    expect(JSON.parse(String(request?.body))).toEqual({
      input: 'Original text.',
      instructions: REWRITE_SYSTEM_PROMPT,
      model: 'gpt-5.5',
      store: false,
    });
    expect(REWRITE_PROMPT_VERSION).toBe('rewrite-v1.1.0');
  });

  it('accepts a top-level output_text compatibility field', async () => {
    const provider = new EbondProvider({
      apiKey: 'provider-secret',
      baseUrl: 'https://api.ebondai.com',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          output_text: 'Compatible response.',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
      model: 'gpt-5.5',
      retryDelayMs: 0,
      timeoutMs: 1_000,
    });

    await expect(provider.rewrite('Original.')).resolves.toEqual({
      inputTokens: 10,
      outputTokens: 5,
      text: 'Compatible response.',
    });
  });

  it('uses Chat Completions only when the adapter is explicitly placed in fallback mode', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'Chat fallback response.' } }],
        usage: { completion_tokens: 7, prompt_tokens: 18 },
      }),
    );
    const provider = new EbondProvider({
      apiKey: 'provider-secret',
      apiMode: 'chat_completions',
      baseUrl: 'https://api.ebondai.com',
      fetch: fetchMock,
      model: 'gpt-5.5',
      retryDelayMs: 0,
      timeoutMs: 1_000,
    });

    await expect(provider.rewrite('Original.')).resolves.toEqual({
      inputTokens: 18,
      outputTokens: 7,
      text: 'Chat fallback response.',
    });

    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.ebondai.com/v1/chat/completions');
    expect(JSON.parse(String(request?.body))).toEqual({
      messages: [
        { content: REWRITE_SYSTEM_PROMPT, role: 'system' },
        { content: 'Original.', role: 'user' },
      ],
      model: 'gpt-5.5',
      stream: false,
    });
  });

  it('puts selected rewrite controls into the provider instructions without a language override', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        output_text: 'A concise professional result.',
        usage: { input_tokens: 12, output_tokens: 4 },
      }),
    );
    const provider = new EbondProvider({
      apiKey: 'provider-secret',
      baseUrl: 'https://api.ebondai.com',
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
    expect(JSON.parse(String(request?.body))).toMatchObject({
      instructions: createRewriteSystemPrompt(options),
    });
    expect(JSON.parse(String(request?.body))).not.toHaveProperty('language');
  });

  it('retries one explicitly retryable HTTP failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'temporary' } }, 503))
      .mockResolvedValueOnce(
        jsonResponse({
          output_text: 'Recovered.',
          usage: { input_tokens: 20, output_tokens: 8 },
        }),
      );
    const provider = new EbondProvider({
      apiKey: 'provider-secret',
      baseUrl: 'https://api.ebondai.com',
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
    const provider = new EbondProvider({
      apiKey: 'provider-secret',
      baseUrl: 'https://api.ebondai.com',
      fetch: fetchMock,
      model: 'gpt-5.5',
      retryDelayMs: 0,
      timeoutMs: 1_000,
    });

    const error = await provider.rewrite('Original.').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EbondProviderError);
    expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', statusCode: 503 });
    expect(String(error)).not.toContain('sensitive provider detail');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('normalizes incomplete Responses output without exposing provider content', async () => {
    const provider = new EbondProvider({
      apiKey: 'provider-secret',
      baseUrl: 'https://api.ebondai.com',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          output_text: 'sensitive partial output',
          usage: { input_tokens: 10 },
        }),
      ),
      model: 'gpt-5.5',
      retryDelayMs: 0,
      timeoutMs: 1_000,
    });

    const error = await provider.rewrite('Original.').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EbondProviderError);
    expect(error).toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    expect(String(error)).not.toContain('sensitive partial output');
  });

  it('times out without retrying an ambiguous provider request', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const provider = new EbondProvider({
      apiKey: 'provider-secret',
      baseUrl: 'https://api.ebondai.com',
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
    const provider = new EbondProvider({
      apiKey: 'provider-secret',
      baseUrl: 'https://api.ebondai.com',
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
    const provider = new EbondProvider({
      apiKey: 'provider-secret',
      baseUrl: 'https://api.ebondai.com',
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
