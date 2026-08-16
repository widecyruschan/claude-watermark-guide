import { describe, expect, it } from 'vitest';

import {
  OpenAiCompatibleProvider,
  RewriteProviderError,
} from '../../src/rewrite/openAiCompatibleProvider';

// Regression: ISSUE-007 — A malformed production Secret failed before the provider returned a status
// Found by /qa on 2026-08-16
// Report: .gstack/qa-reports/qa-report-watermarklens-com-2026-08-15.md
describe('rewrite provider configuration', () => {
  it('rejects header-unsafe API keys without exposing their value', () => {
    const malformedKey = 'sk-first-line\nsecret-second-line';
    let caughtError: unknown;

    try {
      new OpenAiCompatibleProvider({
        apiKey: malformedKey,
        baseUrl: 'https://legacy-provider.example',
        model: 'gpt-5.5',
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(RewriteProviderError);
    expect(caughtError).toMatchObject({ code: 'PROVIDER_CONFIGURATION_ERROR' });
    expect(String(caughtError)).not.toContain(malformedKey);
  });
});
