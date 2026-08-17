import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const contentPagePaths = [
  '../index.html',
  '../pages/checker.html',
  '../pages/changes-2026.html',
  '../pages/how-it-works.html',
  '../pages/what-is-claude-watermark.html',
];

async function readContentPages(): Promise<string[]> {
  return Promise.all(
    contentPagePaths.map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
  );
}

describe('watermark content pages', () => {
  it('contain no editorial placeholder markers', async () => {
    const pages = await readContentPages();
    const placeholderPattern =
      /\[待确[认定][^\]]*\]|\bTBD\b|cite specific|without fabricating|verify against official sources/iu;

    for (const page of pages) {
      expect(page).not.toMatch(placeholderPattern);
    }
  });

  it('cite the official rollout and technical sources with a review date', async () => {
    const [homepage, checker, changes, mechanism, definition] = await readContentPages();
    const officialHelpCenter =
      'https://support.claude.com/en/articles/16266773-how-claude-marks-ai-generated-content';
    const officialTechnicalArticle = 'https://www.anthropic.com/news/claude-text-watermark';

    expect(changes).toContain('Last reviewed:</strong> August 17, 2026');
    expect(changes).toContain(officialHelpCenter);
    expect(changes).toContain(officialTechnicalArticle);
    expect(mechanism).toContain(officialHelpCenter);
    expect(mechanism).toContain(officialTechnicalArticle);
    expect(definition).toContain(officialHelpCenter);
    expect(definition).toContain(officialTechnicalArticle);
    expect(homepage).toContain('SynthID-Text');
    expect(checker).toContain('not yet released, a public detection API');
  });

  it('does not present the local checker as Claude watermark detection', async () => {
    const [homepage, checker] = await Promise.all([
      readFile(new URL('../index.html', import.meta.url), 'utf8'),
      readFile(new URL('../pages/checker.html', import.meta.url), 'utf8'),
    ]);
    const checkerScript = await readFile(new URL('../js/checker.js', import.meta.url), 'utf8');

    expect(homepage).not.toContain('whether your Claude text carries the invisible marker');
    expect(checker).toContain('This tool cannot detect, remove, or bypass that watermark.');
    expect(checkerScript).not.toContain('likely_marked');
    expect(checkerScript).not.toContain('Possibly carries an invisible marker');
    expect(checkerScript).toContain('this result is not watermark detection');
  });
});
