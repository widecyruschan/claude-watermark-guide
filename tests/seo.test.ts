import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface SeoPage {
  canonicalPath?: string;
  filePath: string;
  indexable: boolean;
  primaryTopic?: boolean;
}

const seoPages: SeoPage[] = [
  { canonicalPath: '/', filePath: '../index.html', indexable: true, primaryTopic: true },
  {
    canonicalPath: '/what-is-claude-watermark',
    filePath: '../pages/what-is-claude-watermark.html',
    indexable: true,
    primaryTopic: true,
  },
  {
    canonicalPath: '/how-it-works',
    filePath: '../pages/how-it-works.html',
    indexable: true,
    primaryTopic: true,
  },
  {
    canonicalPath: '/changes-2026',
    filePath: '../pages/changes-2026.html',
    indexable: true,
    primaryTopic: true,
  },
  {
    canonicalPath: '/checker',
    filePath: '../pages/checker.html',
    indexable: true,
    primaryTopic: true,
  },
  { canonicalPath: '/privacy', filePath: '../pages/privacy.html', indexable: true },
  { canonicalPath: '/terms', filePath: '../pages/terms.html', indexable: true },
  { canonicalPath: '/cookie', filePath: '../pages/cookie.html', indexable: true },
  { canonicalPath: '/rewrite', filePath: '../pages/rewrite.html', indexable: false },
  { canonicalPath: '/login', filePath: '../pages/login.html', indexable: false },
  { canonicalPath: '/account', filePath: '../pages/account.html', indexable: false },
  { canonicalPath: '/auth/callback', filePath: '../auth/callback.html', indexable: false },
  { filePath: '../404.html', indexable: false },
];

function getTagContent(html: string, pattern: RegExp, label: string): string {
  const value = html.match(pattern)?.[1]?.trim();
  expect(value, `${label} must exist`).toBeTruthy();
  return value ?? '';
}

async function readSeoPages(): Promise<Array<SeoPage & { html: string }>> {
  return Promise.all(
    seoPages.map(async (page) => ({
      ...page,
      html: await readFile(new URL(page.filePath, import.meta.url), 'utf8'),
    })),
  );
}

describe('technical SEO', () => {
  it('uses unique, descriptive titles and descriptions on every route', async () => {
    const pages = await readSeoPages();
    const titles = pages.map(({ filePath, html }) =>
      getTagContent(html, /<title>([^<]+)<\/title>/iu, `${filePath} title`),
    );
    const descriptions = pages.map(({ filePath, html }) =>
      getTagContent(
        html,
        /<meta\s+name="description"\s+content="([^"]+)"\s*\/>/iu,
        `${filePath} description`,
      ),
    );

    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);

    for (const title of titles) {
      expect(title.length).toBeGreaterThanOrEqual(20);
      expect(title.length).toBeLessThanOrEqual(65);
      expect(title).not.toContain('Claude Watermark Text');
    }

    for (const description of descriptions) {
      expect(description.length).toBeGreaterThanOrEqual(40);
      expect(description.length).toBeLessThanOrEqual(160);
    }
  });

  it('uses one absolute canonical URL and one H1 per canonical route', async () => {
    const pages = await readSeoPages();

    for (const { canonicalPath, filePath, html } of pages) {
      expect(html.match(/<h1(?:\s[^>]*)?>/giu)?.length, `${filePath} H1 count`).toBe(1);

      if (!canonicalPath) {
        expect(html).not.toContain('rel="canonical"');
        continue;
      }

      const canonical = getTagContent(
        html,
        /<link\s+rel="canonical"\s+href="([^"]+)"\s*\/>/iu,
        `${filePath} canonical`,
      );
      const canonicalUrl = new URL(canonical);
      expect(canonicalUrl.origin).toBe('https://watermarklens.com');
      expect(canonicalUrl.pathname).toBe(canonicalPath);
    }
  });

  it('indexes public content and excludes member or system routes', async () => {
    const pages = await readSeoPages();

    for (const { filePath, html, indexable } of pages) {
      if (indexable) {
        expect(html, `${filePath} must remain indexable`).not.toMatch(
          /<meta\s+name="robots"\s+content="[^"]*noindex/iu,
        );
      } else {
        expect(html, `${filePath} must be noindex`).toMatch(
          /<meta\s+name="robots"\s+content="[^"]*noindex/iu,
        );
      }
    }
  });

  it('keeps the primary keyword focused on the public topic cluster', async () => {
    const pages = await readSeoPages();

    for (const { filePath, html, primaryTopic } of pages) {
      if (primaryTopic) {
        expect(html, `${filePath} primary topic`).toMatch(/Claude Text Watermark/iu);
      }
    }
  });

  it('provides complete social metadata on every indexable page', async () => {
    const pages = await readSeoPages();

    for (const { filePath, html, indexable } of pages) {
      if (!indexable) continue;

      for (const attribute of [
        'property="og:type"',
        'property="og:site_name"',
        'property="og:title"',
        'property="og:description"',
        'property="og:url"',
        'name="twitter:card"',
        'name="twitter:title"',
        'name="twitter:description"',
      ]) {
        expect(html, `${filePath} ${attribute}`).toContain(attribute);
      }
    }
  });

  it('contains parseable structured data that matches visible article headings', async () => {
    const pages = await readSeoPages();
    const structuredPages = pages.filter(({ html }) => html.includes('application/ld+json'));

    expect(structuredPages).toHaveLength(4);

    for (const { filePath, html } of structuredPages) {
      const jsonText = getTagContent(
        html,
        /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/iu,
        `${filePath} JSON-LD`,
      );
      const structuredData = JSON.parse(jsonText) as Record<string, unknown>;

      expect(structuredData['@context']).toBe('https://schema.org');

      if (typeof structuredData.headline === 'string') {
        const heading = getTagContent(
          html,
          /<h1(?:\s[^>]*)?>([^<]+)<\/h1>/iu,
          `${filePath} visible H1`,
        );
        expect(structuredData.headline).toContain(heading);
      }
    }
  });

  it('lists only canonical, indexable URLs in the sitemap', async () => {
    const sitemap = await readFile(new URL('../sitemap.xml', import.meta.url), 'utf8');
    const robots = await readFile(new URL('../robots.txt', import.meta.url), 'utf8');
    const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/giu)].map((match) => match[1]);
    const expectedUrls = seoPages
      .filter(({ canonicalPath, indexable }) => indexable && canonicalPath)
      .map(({ canonicalPath }) => new URL(canonicalPath ?? '/', 'https://watermarklens.com').href);

    expect(sitemapUrls).toEqual(expectedUrls);
    expect(sitemap.match(/<lastmod>2026-08-17<\/lastmod>/gu)?.length).toBe(expectedUrls.length);
    expect(robots).toContain('Sitemap: https://watermarklens.com/sitemap.xml');
    expect(robots).not.toContain('Disallow: /');
  });
});
