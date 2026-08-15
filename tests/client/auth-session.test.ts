import { describe, expect, it } from 'vitest';

import { shouldReturnToLogin } from '../../src/client/auth';

describe('member session lifecycle', () => {
  it('returns to login after sign-out or a refresh without a session', () => {
    expect(shouldReturnToLogin('SIGNED_OUT', null)).toBe(true);
    expect(shouldReturnToLogin('TOKEN_REFRESHED', null)).toBe(true);
  });

  it('keeps the account page open after a successful refresh', () => {
    expect(shouldReturnToLogin('TOKEN_REFRESHED', { user: { id: 'user-id' } })).toBe(false);
    expect(shouldReturnToLogin('SIGNED_IN', { user: { id: 'user-id' } })).toBe(false);
  });
});
