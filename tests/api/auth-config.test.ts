import { describe, expect, it } from 'vitest';

import { createApiApp } from '../../src/api/app';

const bindings = {
  EBOND_API_KEY: 'provider-secret-must-not-leak',
  EBOND_BASE_URL: 'https://api.ebondai.com',
  EBOND_MODEL: 'gpt-5.5',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_browser-safe-test-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-must-not-leak',
  SUPABASE_URL: 'https://project-ref.supabase.co',
};

describe('GET /api/v1/auth/config', () => {
  it('returns only the browser-safe Supabase configuration', async () => {
    const response = await createApiApp().request(
      'https://watermarklens.com/api/v1/auth/config',
      undefined,
      bindings,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(body).toEqual({
      success: true,
      message: 'The authentication configuration is available.',
      data: {
        supabasePublishableKey: bindings.SUPABASE_PUBLISHABLE_KEY,
        supabaseUrl: bindings.SUPABASE_URL,
      },
      requestId: response.headers.get('x-request-id'),
    });

    const serializedBody = JSON.stringify(body);
    expect(serializedBody).not.toContain(bindings.EBOND_API_KEY);
    expect(serializedBody).not.toContain(bindings.SUPABASE_SERVICE_ROLE_KEY);
  });

  it('returns a normalized unavailable response when the binding is invalid', async () => {
    const response = await createApiApp().request(
      'https://watermarklens.com/api/v1/auth/config',
      undefined,
      {
        ...bindings,
        SUPABASE_PUBLISHABLE_KEY: '',
      },
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      success: false,
      message: 'Authentication is temporarily unavailable.',
      error: {
        code: 'AUTH_CONFIGURATION_ERROR',
        details: 'Contact support before retrying sign-in.',
      },
      requestId: response.headers.get('x-request-id'),
    });
  });
});
