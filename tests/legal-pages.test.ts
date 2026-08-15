import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('legal page drafts', () => {
  it('use the confirmed domain, contact address, and review date', async () => {
    const pageNames = ['privacy', 'cookie', 'terms'];
    const pages = await Promise.all(
      pageNames.map((pageName) =>
        readFile(new URL(`../pages/${pageName}.html`, import.meta.url), 'utf8'),
      ),
    );

    pages.forEach((page, index) => {
      expect(page).toContain(`https://watermarklens.com/${pageNames[index]}`);
      expect(page).toContain('contact@watermarklens.com');
      expect(page).toContain('Last updated: 16 August 2026');
      expect(page).toContain('Legal review is still required');
      expect(page).not.toMatch(/\[待确[认定]/u);
    });
  });
});
