import { describe, expect, it, vi } from 'vitest';

import { EbondProvider } from '../../src/rewrite/ebondProvider';

// Regression: ISSUE-007 — Provider transport failures did not distinguish gateway auth from model calls
// Found by /qa on 2026-08-16
// Report: .gstack/qa-reports/qa-report-watermarklens-com-2026-08-15.md
describe('EBond provider connectivity diagnostics', () => {
  it('records only model availability and HTTP status after a transport failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('provider transport failed with sensitive details'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }] }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      );
    const provider = new EbondProvider({
      apiKey: 'sk-provider-secret',
      baseUrl: 'https://api.ebondai.com',
      enableConnectivityProbe: true,
      fetch: fetchMock,
      model: 'gpt-5.5',
      timeoutMs: 1_000,
    });

    const error = await provider.rewrite('Sensitive user text.').catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      diagnosticModelAvailable: true,
      diagnosticStatusCode: 200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(error)).not.toContain('Sensitive user text.');
    expect(String(error)).not.toContain('sk-provider-secret');
  });
});
