import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Regression: ISSUE-004 — Published policy named analytics services that were not deployed
// Found by /qa on 2026-08-16
// Report: .gstack/qa-reports/qa-report-watermarklens-com-2026-08-15.md
describe('published analytics policy', () => {
  const googleTagId = 'G-G04WGCK8BF';
  const taggedPagePaths = [
    '../index.html',
    '../404.html',
    '../pages/account.html',
    '../pages/changes-2026.html',
    '../pages/checker.html',
    '../pages/cookie.html',
    '../pages/how-it-works.html',
    '../pages/login.html',
    '../pages/privacy.html',
    '../pages/rewrite.html',
    '../pages/terms.html',
    '../pages/what-is-claude-watermark.html',
  ];

  it('installs the Google tag once on every measured page', async () => {
    const pages = await Promise.all(
      taggedPagePaths.map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
    );

    for (const page of pages) {
      expect(page.match(/www\.googletagmanager\.com\/gtag\/js/gu)).toHaveLength(1);
      expect(page).toContain(`gtag/js?id=${googleTagId}`);
      expect(page).toContain(`gtag('config', '${googleTagId}');`);
    }
  });

  it('does not load analytics on the OAuth callback page', async () => {
    const callback = await readFile(new URL('../auth/callback.html', import.meta.url), 'utf8');

    expect(callback).not.toContain('googletagmanager.com');
    expect(callback).not.toContain(googleTagId);
    expect(callback).not.toContain('plausible.shipsolo.io');
  });

  it('keeps the published policies aligned with both analytics services', async () => {
    const [homepage, privacy, cookie] = await Promise.all([
      readFile(new URL('../index.html', import.meta.url), 'utf8'),
      readFile(new URL('../pages/privacy.html', import.meta.url), 'utf8'),
      readFile(new URL('../pages/cookie.html', import.meta.url), 'utf8'),
    ]);

    expect(homepage).toContain('https://plausible.shipsolo.io/js/script.js');

    for (const policy of [privacy, cookie]) {
      expect(policy).toContain('Plausible');
      expect(policy).toContain('Google Analytics 4');
      expect(policy).toContain(googleTagId);
      expect(policy).not.toContain('Microsoft Clarity');
    }
  });
});
