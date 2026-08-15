import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApiApp, validateJsonBody } from '../../src/api/app';

const bindings = {
  EBOND_API_KEY: 'test-secret-must-not-leak',
  EBOND_BASE_URL: 'https://api.ebondai.com',
  EBOND_MODEL: 'gpt-5.5',
};

describe('GET /api/v1/health', () => {
  it('reports API health without exposing configuration secrets', async () => {
    const response = await createApiApp().request(
      'https://watermarklens.com/api/v1/health',
      undefined,
      bindings,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const body = await response.json();
    const requestId = response.headers.get('x-request-id');

    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toEqual({
      success: true,
      data: {
        service: 'claude-watermark-api',
        status: 'ok',
      },
      requestId,
    });
    expect(JSON.stringify(body)).not.toContain(bindings.EBOND_API_KEY);
  });
});

describe('API error responses', () => {
  it('returns the shared JSON contract for unknown routes', async () => {
    const response = await createApiApp().request(
      'https://watermarklens.com/api/v1/missing',
      undefined,
      bindings,
    );

    expect(response.status).toBe(404);

    const body = await response.json();
    const requestId = response.headers.get('x-request-id');

    expect(body).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.',
      },
      requestId,
    });
  });

  it('hides unexpected error details behind the shared JSON contract', async () => {
    const app = createApiApp();
    app.get('/api/v1/failure', () => {
      throw new Error('sensitive internal detail');
    });

    const response = await app.request(
      'https://watermarklens.com/api/v1/failure',
      undefined,
      bindings,
    );
    const responseText = await response.text();
    const requestId = response.headers.get('x-request-id');

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The service could not complete the request.',
      },
      requestId,
    });
    expect(responseText).not.toContain('sensitive internal detail');
  });
});

describe('JSON request validation', () => {
  it('rejects payloads that do not match the route schema', async () => {
    const app = createApiApp();
    app.post(
      '/api/v1/validation-test',
      validateJsonBody(z.object({ text: z.string().min(1) })),
      (context) => context.json({ success: true }),
    );

    const response = await app.request(
      'https://watermarklens.com/api/v1/validation-test',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '' }),
      },
      bindings,
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The request payload is invalid.',
      },
      requestId: response.headers.get('x-request-id'),
    });
  });
});
