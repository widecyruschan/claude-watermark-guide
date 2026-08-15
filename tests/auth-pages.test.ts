import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('member authentication pages', () => {
  it('exposes the Google sign-in, callback, account, and sign-out surfaces', async () => {
    const [homepage, loginPage, callbackPage, accountPage] = await Promise.all([
      readFile(new URL('../index.html', import.meta.url), 'utf8'),
      readFile(new URL('../pages/login.html', import.meta.url), 'utf8'),
      readFile(new URL('../auth/callback.html', import.meta.url), 'utf8'),
      readFile(new URL('../pages/account.html', import.meta.url), 'utf8'),
    ]);

    expect(homepage).toContain('href="/login"');

    expect(loginPage).toContain('data-auth-page="login"');
    expect(loginPage).toContain('id="googleSignInButton"');
    expect(loginPage).toContain('Continue with Google');

    expect(callbackPage).toContain('data-auth-page="callback"');
    expect(callbackPage).toContain('Completing sign-in');

    expect(accountPage).toContain('data-auth-page="account"');
    expect(accountPage).toContain('id="accountEmail"');
    expect(accountPage).toContain('id="accountBillingStatus"');
    expect(accountPage).toContain('id="accountPeriod"');
    expect(accountPage).toContain('id="accountUsage"');
    expect(accountPage).toContain('id="signOutButton"');

    for (const page of [loginPage, callbackPage, accountPage]) {
      expect(page).toContain('src="/js/auth.js"');
      expect(page).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(page).not.toContain('EBOND_API_KEY');
      expect(page).not.toContain('GOOGLE_CLIENT_SECRET');
    }
  });
});
