import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApiApp } from '../../src/api/app';
import { RewriteProviderError } from '../../src/rewrite/openAiCompatibleProvider';
import { RewriteError, type RewriteRuntime } from '../../src/rewrite/rewriteService';

const bindings = {
  REWRITE_API_KEY: 'provider-key-must-not-leak',
  REWRITE_API_MODE: 'chat_completions',
  REWRITE_BASE_URL: 'https://breakout.wenwen-ai.com',
  REWRITE_MODEL: 'gpt-5.5',
  SUPABASE_SERVICE_ROLE_KEY: 'database-key-must-not-leak',
  SUPABASE_URL: 'https://example.supabase.co',
};
const userId = '3e7a3d9a-d52a-4bd7-aaad-8ddcad1e53de';
const idempotencyKey = 'd5322ba3-836b-45aa-8c3f-a295d308f2df';

afterEach(() => {
  vi.restoreAllMocks();
});

function createRequest(text: string, key = idempotencyKey): Request {
  return new Request('https://watermarklens.com/api/v1/rewrite', {
    body: JSON.stringify({ text }),
    headers: {
      authorization: 'Bearer user-jwt-must-not-leak',
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    method: 'POST',
  });
}

function createSuccessfulRuntime(): RewriteRuntime {
  return {
    authenticator: {
      authenticate: vi.fn().mockResolvedValue({ userId }),
    },
    provider: {
      rewrite: vi.fn().mockResolvedValue({
        inputTokens: 250,
        outputTokens: 125,
        text: 'A natural rewrite.',
      }),
    },
    repository: {
      beginRewriteRequest: vi.fn().mockResolvedValue({
        claimState: 'claimed',
        remainingCharacters: 9_000,
      }),
      completeRewriteRequest: vi.fn().mockResolvedValue({ remainingCharacters: 9_000 }),
      failRewriteRequest: vi.fn().mockResolvedValue({ remainingCharacters: 10_000 }),
    },
  };
}

describe('POST /api/v1/rewrite', () => {
  it('authenticates, claims quota and settles provider usage', async () => {
    const runtime = createSuccessfulRuntime();
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const app = createApiApp({ rewriteRuntimeFactory: () => runtime });

    const response = await app.request(createRequest('  Original text.  '), undefined, bindings);
    const responseText = await response.text();
    const body = JSON.parse(responseText);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      data: {
        text: 'A natural rewrite.',
        usage: {
          chargedCharacters: 14,
          remainingCharacters: 9_000,
        },
      },
      message: 'The text was rewritten.',
      requestId: response.headers.get('x-request-id'),
      success: true,
    });
    expect(runtime.authenticator.authenticate).toHaveBeenCalledWith(
      'Bearer user-jwt-must-not-leak',
    );
    expect(runtime.provider.rewrite).toHaveBeenCalledWith(
      'Original text.',
      { formality: 'medium', strength: 'medium', tone: 'neutral' },
      expect.any(AbortSignal),
    );
    expect(runtime.repository.beginRewriteRequest).toHaveBeenCalledWith({
      inputCharacters: 14,
      inputSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      model: 'gpt-5.5',
      promptVersion: 'rewrite-v1.1.0',
      provider: 'wenwen',
      requestId: idempotencyKey,
      userId,
    });
    expect(runtime.repository.completeRewriteRequest).toHaveBeenCalledWith({
      costMicrousd: 500,
      inputTokens: 250,
      outputTokens: 125,
      requestId: idempotencyKey,
      userId,
    });
    expect(runtime.repository.failRewriteRequest).not.toHaveBeenCalled();

    const serializedLogs = JSON.stringify(consoleInfo.mock.calls);
    expect(serializedLogs).not.toContain('Original text.');
    expect(serializedLogs).not.toContain('A natural rewrite.');
    expect(serializedLogs).not.toContain('user-jwt-must-not-leak');
    expect(serializedLogs).not.toContain(bindings.REWRITE_API_KEY);
    expect(serializedLogs).not.toContain(bindings.SUPABASE_SERVICE_ROLE_KEY);
  });

  it('never invokes or charges the provider twice for a completed key', async () => {
    const runtime = createSuccessfulRuntime();
    let requestState: 'processing' | 'succeeded' = 'processing';
    vi.mocked(runtime.repository.beginRewriteRequest).mockImplementation(async () => ({
      claimState: requestState === 'processing' ? 'claimed' : 'succeeded',
      remainingCharacters: 9_000,
    }));
    vi.mocked(runtime.repository.completeRewriteRequest).mockImplementation(async () => {
      requestState = 'succeeded';
      return { remainingCharacters: 9_000 };
    });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const app = createApiApp({ rewriteRuntimeFactory: () => runtime });

    const first = await app.request(createRequest('Original text.'), undefined, bindings);
    const duplicate = await app.request(createRequest('Original text.'), undefined, bindings);

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      error: { code: 'IDEMPOTENCY_ALREADY_COMPLETED' },
      success: false,
    });
    expect(runtime.provider.rewrite).toHaveBeenCalledOnce();
    expect(runtime.repository.completeRewriteRequest).toHaveBeenCalledOnce();
  });

  it('releases reserved quota after an eligible provider failure', async () => {
    const runtime = createSuccessfulRuntime();
    vi.mocked(runtime.provider.rewrite).mockRejectedValue(
      new RewriteProviderError('PROVIDER_UNAVAILABLE'),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApiApp({ rewriteRuntimeFactory: () => runtime });

    const response = await app.request(createRequest('Sensitive original.'), undefined, bindings);
    const responseText = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(responseText)).toMatchObject({
      error: { code: 'PROVIDER_UNAVAILABLE' },
      success: false,
    });
    expect(runtime.repository.failRewriteRequest).toHaveBeenCalledWith({
      errorCode: 'PROVIDER_UNAVAILABLE',
      requestId: idempotencyKey,
      userId,
    });
    expect(runtime.repository.completeRewriteRequest).not.toHaveBeenCalled();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('Sensitive original.');
  });

  it('does not accept legacy provider bindings after the cutover', async () => {
    const runtime = createSuccessfulRuntime();
    const app = createApiApp({ rewriteRuntimeFactory: () => runtime });
    const response = await app.request(createRequest('Original text.'), undefined, {
      ...bindings,
      EBOND_API_KEY: 'legacy-provider-key-must-not-leak',
      EBOND_API_MODE: 'responses',
      EBOND_BASE_URL: 'https://legacy-provider.example',
      EBOND_MODEL: 'gpt-5.5',
      REWRITE_API_KEY: undefined,
      REWRITE_API_MODE: undefined,
      REWRITE_BASE_URL: undefined,
      REWRITE_MODEL: undefined,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROVIDER_CONFIGURATION_ERROR' },
      success: false,
    });
    expect(runtime.repository.beginRewriteRequest).not.toHaveBeenCalled();
    expect(runtime.provider.rewrite).not.toHaveBeenCalled();
  });

  it('rejects Responses mode for the new provider bindings', async () => {
    const runtime = createSuccessfulRuntime();
    const app = createApiApp({ rewriteRuntimeFactory: () => runtime });
    const response = await app.request(createRequest('Original text.'), undefined, {
      ...bindings,
      REWRITE_API_MODE: 'responses',
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROVIDER_CONFIGURATION_ERROR' },
      success: false,
    });
    expect(runtime.repository.beginRewriteRequest).not.toHaveBeenCalled();
    expect(runtime.provider.rewrite).not.toHaveBeenCalled();
  });

  it('keeps the reservation and logs safely when settlement fails after provider success', async () => {
    const runtime = createSuccessfulRuntime();
    vi.mocked(runtime.repository.completeRewriteRequest).mockRejectedValue(
      new RewriteError('DATABASE_UNAVAILABLE'),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApiApp({ rewriteRuntimeFactory: () => runtime });

    const response = await app.request(
      createRequest('Settlement-sensitive original.'),
      undefined,
      bindings,
    );

    expect(response.status).toBe(503);
    expect(runtime.repository.completeRewriteRequest).toHaveBeenCalledTimes(3);
    expect(runtime.repository.failRewriteRequest).not.toHaveBeenCalled();
    const serializedLogs = JSON.stringify(consoleError.mock.calls);
    expect(serializedLogs).toContain('rewrite_quota_settlement_failed');
    expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toMatchObject({
      costMicrousd: 500,
      inputTokens: 250,
      outputTokens: 125,
    });
    expect(serializedLogs).not.toContain('Settlement-sensitive original.');
    expect(serializedLogs).not.toContain('A natural rewrite.');
  });

  it('rejects missing authentication and malformed idempotency keys', async () => {
    const runtime = createSuccessfulRuntime();
    vi.mocked(runtime.authenticator.authenticate).mockRejectedValue(
      new RewriteError('AUTHENTICATION_REQUIRED'),
    );
    const app = createApiApp({ rewriteRuntimeFactory: () => runtime });
    const missingAuthentication = createRequest('Original text.');
    missingAuthentication.headers.delete('authorization');

    const unauthenticated = await app.request(missingAuthentication, undefined, bindings);
    vi.mocked(runtime.authenticator.authenticate).mockResolvedValue({ userId });
    const invalidKey = await app.request(
      createRequest('Original text.', 'not-a-uuid'),
      undefined,
      bindings,
    );

    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toMatchObject({
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(invalidKey.status).toBe(422);
    await expect(invalidKey.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
  });

  it('enforces the raw body limit before JSON parsing', async () => {
    const runtime = createSuccessfulRuntime();
    const app = createApiApp({ rewriteRuntimeFactory: () => runtime });
    const oversizedBody = JSON.stringify({ text: 'a'.repeat(110_000) });
    const request = new Request('https://watermarklens.com/api/v1/rewrite', {
      body: oversizedBody,
      headers: {
        authorization: 'Bearer user-jwt-must-not-leak',
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      method: 'POST',
    });

    const response = await app.request(request, undefined, bindings);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });
    expect(runtime.authenticator.authenticate).not.toHaveBeenCalled();
    expect(runtime.provider.rewrite).not.toHaveBeenCalled();
  });
});
