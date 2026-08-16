import { describe, expect, it, vi } from 'vitest';

import { createApiApp } from '../../src/api/app';
import { AccountDeletionError } from '../../src/rewrite/rewriteService';

const bindings = {
  EBOND_API_KEY: 'provider-key-must-not-leak',
  EBOND_BASE_URL: 'https://api.ebondai.com',
  EBOND_MODEL: 'gpt-5.5',
  SUPABASE_SERVICE_ROLE_KEY: 'database-key-must-not-leak',
  SUPABASE_URL: 'https://example.supabase.co',
};

function createRequest(authorization = 'Bearer user-jwt-must-not-leak'): Request {
  return new Request('https://watermarklens.com/api/v1/account/delete', {
    headers: { authorization },
    method: 'POST',
  });
}

describe('POST /api/v1/account/delete', () => {
  it('deletes only through the authenticated, recent-sign-in gateway', async () => {
    const deleteRecentlyAuthenticatedUser = vi.fn().mockResolvedValue(undefined);
    const app = createApiApp({
      accountDeletionGatewayFactory: () => ({ deleteRecentlyAuthenticatedUser }),
    });

    const response = await app.request(createRequest(), undefined, bindings);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: null,
      message: 'The account was deleted.',
      success: true,
    });
    expect(deleteRecentlyAuthenticatedUser).toHaveBeenCalledWith(
      'Bearer user-jwt-must-not-leak',
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
  });

  it('requires a new sign-in when the deletion gateway rejects stale authentication', async () => {
    const app = createApiApp({
      accountDeletionGatewayFactory: () => ({
        deleteRecentlyAuthenticatedUser: vi
          .fn()
          .mockRejectedValue(new AccountDeletionError('RECENT_AUTHENTICATION_REQUIRED')),
      }),
    });

    const response = await app.request(createRequest(), undefined, bindings);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'RECENT_AUTHENTICATION_REQUIRED' },
      success: false,
    });
  });

  it('does not expose a service-role failure when deletion is unavailable', async () => {
    const app = createApiApp({
      accountDeletionGatewayFactory: () => ({
        deleteRecentlyAuthenticatedUser: vi
          .fn()
          .mockRejectedValue(new AccountDeletionError('ACCOUNT_DELETE_UNAVAILABLE')),
      }),
    });

    const response = await app.request(createRequest(), undefined, bindings);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      error: { code: 'ACCOUNT_DELETE_UNAVAILABLE' },
      success: false,
    });
    expect(JSON.stringify(body)).not.toContain(bindings.SUPABASE_SERVICE_ROLE_KEY);
  });
});
