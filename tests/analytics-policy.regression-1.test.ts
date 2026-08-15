import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Regression: ISSUE-004 — Published policy named analytics services that were not deployed
// Found by /qa on 2026-08-16
// Report: .gstack/qa-reports/qa-report-watermarklens-com-2026-08-15.md
describe('published analytics policy', () => {
  it('matches the cookieless Plausible integration used by the homepage', async () => {
    const [homepage, privacy, cookie] = await Promise.all([
      readFile(new URL('../index.html', import.meta.url), 'utf8'),
      readFile(new URL('../pages/privacy.html', import.meta.url), 'utf8'),
      readFile(new URL('../pages/cookie.html', import.meta.url), 'utf8'),
    ]);

    expect(homepage).toContain('https://plausible.shipsolo.io/js/script.js');
    expect(homepage).not.toContain('cookieBanner');

    for (const policy of [privacy, cookie]) {
      expect(policy).toContain('Plausible');
      expect(policy).not.toContain('Google Analytics 4');
      expect(policy).not.toContain('Microsoft Clarity');
    }
  });
});
