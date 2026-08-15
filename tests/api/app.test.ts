import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createApiApp, successResponse, validateJsonBody } from '../../src/api/app';

const bindings = {
  EBOND_API_KEY: 'test-secret-must-not-leak',
  EBOND_BASE_URL: 'https://api.ebondai.com',
  EBOND_MODEL: 'gpt-5.5',
};

afterEach(() => {
  vi.restoreAllMocks();
});

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
      message: 'The API is healthy.',
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
      message: 'The requested resource was not found.',
      error: {
        code: 'NOT_FOUND',
        details: 'No API route matches this request.',
      },
      requestId,
    });
  });

  it('hides unexpected error details behind the shared JSON contract', async () => {
    const app = createApiApp();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    app.get('/api/v1/failure', () => {
      throw new Error('sensitive internal detail');
    });

    const response = await app.request(
      'https://watermarklens.com/api/v1/failure',
      {
        headers: {
          'cf-connecting-ip': '203.0.113.10',
        },
      },
      bindings,
    );
    const responseText = await response.text();
    const requestId = response.headers.get('x-request-id');

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({
      success: false,
      message: 'The service could not complete the request.',
      error: {
        code: 'INTERNAL_ERROR',
        details: 'An unexpected error occurred.',
      },
      requestId,
    });
    expect(responseText).not.toContain('sensitive internal detail');
    expect(consoleError).toHaveBeenCalledOnce();

    const logEntry = JSON.parse(String(consoleError.mock.calls[0]?.[0]));

    expect(logEntry).toMatchObject({
      level: 'error',
      event: 'unhandled_api_error',
      requestId,
      method: 'GET',
      path: '/api/v1/failure',
      userId: null,
      ip: '203.0.113.10',
      statusCode: 500,
      errorCode: 'INTERNAL_ERROR',
      errorMessage: 'An unexpected error occurred.',
      errorName: 'Error',
    });
    expect(logEntry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(logEntry.durationMs).toBeTypeOf('number');
    expect(logEntry.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(logEntry)).not.toContain('sensitive internal detail');
  });
});

describe('JSON request validation', () => {
  it('rejects payloads that do not match the route schema', async () => {
    const app = createApiApp();
    app.post(
      '/api/v1/validation-test',
      validateJsonBody(z.object({ text: z.string().min(1) })),
      (context) => successResponse(context, 'The payload is valid.', null),
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
      message: 'The request payload is invalid.',
      error: {
        code: 'VALIDATION_FAILED',
        details: 'Check the submitted fields and try again.',
      },
      requestId: response.headers.get('x-request-id'),
    });
  });
});
