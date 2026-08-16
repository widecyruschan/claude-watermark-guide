import { describe, expect, it, vi } from 'vitest';

import {
  completeOAuthCallback,
  resolvePostSignInPath,
  shouldStartReauthentication,
} from '../../src/client/auth';

describe('OAuth callback completion', () => {
  it('exchanges an authorization code for a Supabase session', async () => {
    const exchangeCodeForSession = vi.fn().mockResolvedValue({
      data: { session: { user: { id: 'user-id' } } },
      error: null,
    });
    const getSession = vi.fn();

    const result = await completeOAuthCallback(
      { exchangeCodeForSession, getSession },
      new URL('https://watermarklens.com/auth/callback?code=authorization-code'),
    );

    expect(exchangeCodeForSession).toHaveBeenCalledWith('authorization-code');
    expect(getSession).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('rejects provider errors without attempting a code exchange', async () => {
    const exchangeCodeForSession = vi.fn();
    const getSession = vi.fn();

    const result = await completeOAuthCallback(
      { exchangeCodeForSession, getSession },
      new URL('https://watermarklens.com/auth/callback?error=access_denied'),
    );

    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      message: 'Sign-in was not completed. Please try again.',
    });
  });

  it('recovers an existing session when an exchanged callback is replayed', async () => {
    const exchangeCodeForSession = vi.fn().mockResolvedValue({
      data: { session: null },
      error: { message: 'Code verifier is no longer available.' },
    });
    const getSession = vi.fn().mockResolvedValue({
      data: { session: { user: { id: 'user-id' } } },
      error: null,
    });

    const result = await completeOAuthCallback(
      { exchangeCodeForSession, getSession },
      new URL('https://watermarklens.com/auth/callback?code=already-exchanged-code'),
    );

    expect(exchangeCodeForSession).toHaveBeenCalledWith('already-exchanged-code');
    expect(getSession).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true });
  });
});

describe('post sign-in navigation', () => {
  it('returns only to supported member pages', () => {
    expect(
      resolvePostSignInPath(new URL('https://watermarklens.com/auth/callback?next=/rewrite')),
    ).toBe('/rewrite');
    expect(
      resolvePostSignInPath(
        new URL('https://watermarklens.com/auth/callback?next=https://example.com'),
      ),
    ).toBe('/account');
  });

  it('allows an explicit local sign-out only for the account-deletion reauthentication flow', () => {
    expect(shouldStartReauthentication(new URL('https://watermarklens.com/login?reauth=1'))).toBe(
      true,
    );
    expect(shouldStartReauthentication(new URL('https://watermarklens.com/login?reauth=0'))).toBe(
      false,
    );
  });
});
