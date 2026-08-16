import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REWRITE_OPTIONS,
  REWRITE_MAX_CHARACTERS,
  countUnicodeCharacters,
  rewriteInputSchema,
} from '../../src/rewrite/contracts';

describe('rewrite input contract', () => {
  it('trims the submitted text and counts Unicode code points', () => {
    const parsed = rewriteInputSchema.parse({ text: '  保留 emoji 👍  ' });

    expect(parsed).toEqual({
      options: DEFAULT_REWRITE_OPTIONS,
      text: '保留 emoji 👍',
    });
    expect(countUnicodeCharacters(parsed.text)).toBe(10);
  });

  it('rejects empty, oversized and unknown fields', () => {
    expect(rewriteInputSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(
      rewriteInputSchema.safeParse({ text: 'a'.repeat(REWRITE_MAX_CHARACTERS + 1) }).success,
    ).toBe(false);
    expect(rewriteInputSchema.safeParse({ text: 'valid', mode: 'aggressive' }).success).toBe(false);
  });

  it('accepts only the product rewrite controls', () => {
    expect(
      rewriteInputSchema.parse({
        options: { formality: 'high', strength: 'low', tone: 'professional' },
        text: 'Valid text.',
      }),
    ).toMatchObject({
      options: { formality: 'high', strength: 'low', tone: 'professional' },
    });
    expect(
      rewriteInputSchema.safeParse({
        options: { formality: 'very_high', strength: 'low', tone: 'professional' },
        text: 'Valid text.',
      }).success,
    ).toBe(false);
  });

  it('applies the limit to Unicode characters rather than UTF-16 code units', () => {
    expect(
      rewriteInputSchema.safeParse({ text: '👍'.repeat(REWRITE_MAX_CHARACTERS) }).success,
    ).toBe(true);
  });
});
