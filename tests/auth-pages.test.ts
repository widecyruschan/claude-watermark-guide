import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('member authentication pages', () => {
  it('exposes Magic Link, Google sign-in, callback, account, and sign-out surfaces', async () => {
    const [homepage, loginPage, callbackPage, accountPage, rewritePage, checkerPage] =
      await Promise.all([
        readFile(new URL('../index.html', import.meta.url), 'utf8'),
        readFile(new URL('../pages/login.html', import.meta.url), 'utf8'),
        readFile(new URL('../auth/callback.html', import.meta.url), 'utf8'),
        readFile(new URL('../pages/account.html', import.meta.url), 'utf8'),
        readFile(new URL('../pages/rewrite.html', import.meta.url), 'utf8'),
        readFile(new URL('../pages/checker.html', import.meta.url), 'utf8'),
      ]);

    expect(homepage).toContain('href="/login"');
    expect(homepage).toContain('href="/rewrite"');

    expect(loginPage).toContain('data-auth-page="login"');
    expect(loginPage).toContain('id="magicLinkForm"');
    expect(loginPage).toContain('id="magicLinkEmail"');
    expect(loginPage).toContain('Email me a Magic Link');
    expect(loginPage).toContain('id="googleSignInButton"');
    expect(loginPage).toContain('Continue with Google');

    expect(callbackPage).toContain('data-auth-page="callback"');
    expect(callbackPage).toContain('Completing sign-in');

    expect(accountPage).toContain('data-auth-page="account"');
    expect(accountPage).toContain('id="accountEmail"');
    expect(accountPage).toContain('id="accountBillingStatus"');
    expect(accountPage).toContain('id="accountPeriod"');
    expect(accountPage).toContain('id="accountUsage"');
    expect(accountPage).toContain('id="accountUsageProgress"');
    expect(accountPage).toContain('id="accountMenu"');
    expect(accountPage).toContain('id="signOutButton"');
    expect(accountPage).toContain('id="confirmDeleteAccountButton"');
    expect(accountPage).toContain('id="reauthenticateLink"');

    expect(rewritePage).toContain('id="rewriteForm"');
    expect(rewritePage).toContain('id="rewriteTone"');
    expect(rewritePage).toContain('id="rewriteFormality"');
    expect(rewritePage).toContain('id="rewriteStrength"');
    expect(rewritePage).toContain('id="rewriteCancelButton"');
    expect(rewritePage).toContain('id="copyRewriteResultButton"');
    expect(rewritePage).toContain('id="downloadRewriteResultButton"');
    expect(rewritePage).toContain('src="/js/rewrite.js"');
    expect(rewritePage).not.toContain('maxlength=');
    expect(rewritePage).not.toContain('language"');
    expect(checkerPage).toContain('Your text is processed in your browser only.');
    expect(checkerPage).toContain('AI Text Rewriter');
    expect(checkerPage).toContain('href="/rewrite"');

    for (const page of [loginPage, callbackPage, accountPage]) {
      expect(page).toContain('src="/js/auth.js"');
      expect(page).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(page).not.toContain('EBOND_API_KEY');
      expect(page).not.toContain('GOOGLE_CLIENT_SECRET');
    }
  });
});
