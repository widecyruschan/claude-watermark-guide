import { describe, expect, it } from 'vitest';

import { resolveRewriteFailure } from '../../src/client/rewrite';

describe('rewrite failure recovery', () => {
  it('asks for sign-in after an expired session without treating it as an upgrade event', () => {
    expect(resolveRewriteFailure(401, 'AUTHENTICATION_REQUIRED')).toEqual({
      disableSubmission: true,
      showUpgrade: false,
      status: 'Your session expired. Sign in again to retry; your draft is still here.',
    });
  });

  it('shows an upgrade path for request and allowance limits', () => {
    expect(resolveRewriteFailure(422, 'REQUEST_LIMIT_EXCEEDED').showUpgrade).toBe(true);
    expect(resolveRewriteFailure(429, 'QUOTA_EXCEEDED').showUpgrade).toBe(true);
    expect(resolveRewriteFailure(503, 'PROVIDER_UNAVAILABLE').showUpgrade).toBe(false);
    expect(resolveRewriteFailure(422, 'REQUEST_LIMIT_EXCEEDED').disableSubmission).toBe(false);
  });
});
