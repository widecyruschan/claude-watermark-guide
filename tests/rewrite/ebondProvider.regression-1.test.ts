import { describe, expect, it } from 'vitest';

import { EbondProvider, EbondProviderError } from '../../src/rewrite/ebondProvider';

// Regression: ISSUE-007 — A malformed production Secret failed before EBond returned an HTTP status
// Found by /qa on 2026-08-16
// Report: .gstack/qa-reports/qa-report-watermarklens-com-2026-08-15.md
describe('EBond provider configuration', () => {
  it('rejects header-unsafe API keys without exposing their value', () => {
    const malformedKey = 'sk-first-line\nsecret-second-line';
    let caughtError: unknown;

    try {
      new EbondProvider({
        apiKey: malformedKey,
        baseUrl: 'https://api.ebondai.com',
        model: 'gpt-5.5',
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(EbondProviderError);
    expect(caughtError).toMatchObject({ code: 'PROVIDER_CONFIGURATION_ERROR' });
    expect(String(caughtError)).not.toContain(malformedKey);
  });
});
