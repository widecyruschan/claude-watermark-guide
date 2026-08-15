import { describe, expect, it } from 'vitest';

import { resolveEffectivePlan } from '../../src/client/auth';

const now = new Date('2026-08-16T12:00:00.000Z');

describe('member entitlement display', () => {
  it('shows Pro only for an active or trialing subscription in its current period', () => {
    expect(
      resolveEffectivePlan(
        {
          current_period_end: '2026-09-01T00:00:00.000Z',
          current_period_start: '2026-08-01T00:00:00.000Z',
          plan_code: 'pro',
          status: 'active',
        },
        now,
      ),
    ).toBe('pro');

    expect(
      resolveEffectivePlan(
        {
          current_period_end: '2026-09-01T00:00:00.000Z',
          current_period_start: '2026-08-01T00:00:00.000Z',
          plan_code: 'pro',
          status: 'trialing',
        },
        now,
      ),
    ).toBe('pro');
  });

  it.each(['past_due', 'canceled', 'inactive'])(
    'shows Free when a Pro subscription is %s',
    (status) => {
      expect(
        resolveEffectivePlan(
          {
            current_period_end: '2026-09-01T00:00:00.000Z',
            current_period_start: '2026-08-01T00:00:00.000Z',
            plan_code: 'pro',
            status,
          },
          now,
        ),
      ).toBe('free');
    },
  );

  it('shows Free outside the paid subscription period', () => {
    expect(
      resolveEffectivePlan(
        {
          current_period_end: '2026-08-01T00:00:00.000Z',
          current_period_start: '2026-07-01T00:00:00.000Z',
          plan_code: 'pro',
          status: 'active',
        },
        now,
      ),
    ).toBe('free');
  });
});
