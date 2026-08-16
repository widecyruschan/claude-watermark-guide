import { describe, expect, it } from 'vitest';

import { resolveBillingPresentation, resolveEffectivePlan } from '../../src/client/auth';

const now = new Date('2026-08-16T12:00:00.000Z');

describe('member entitlement display', () => {
  it('shows Pro only for an active or trialing subscription in its current period', () => {
    expect(
      resolveEffectivePlan(
        {
          cancel_at_period_end: false,
          current_period_end: '2026-09-01T00:00:00.000Z',
          current_period_start: '2026-08-01T00:00:00.000Z',
          grace_period_end: null,
          plan_code: 'pro',
          status: 'active',
        },
        now,
      ),
    ).toBe('pro');

    expect(
      resolveEffectivePlan(
        {
          cancel_at_period_end: false,
          current_period_end: '2026-09-01T00:00:00.000Z',
          current_period_start: '2026-08-01T00:00:00.000Z',
          grace_period_end: null,
          plan_code: 'pro',
          status: 'trialing',
        },
        now,
      ),
    ).toBe('pro');
  });

  it.each(['canceled', 'inactive'])('shows Free when a Pro subscription is %s', (status) => {
    expect(
      resolveEffectivePlan(
        {
          cancel_at_period_end: false,
          current_period_end: '2026-09-01T00:00:00.000Z',
          current_period_start: '2026-08-01T00:00:00.000Z',
          grace_period_end: null,
          plan_code: 'pro',
          status,
        },
        now,
      ),
    ).toBe('free');
  });

  it('shows Pro only while a past-due grace period remains valid', () => {
    const subscription = {
      cancel_at_period_end: false,
      current_period_end: '2026-09-01T00:00:00.000Z',
      current_period_start: '2026-08-01T00:00:00.000Z',
      grace_period_end: '2026-08-18T12:00:00.000Z',
      plan_code: 'pro',
      status: 'past_due',
    };

    expect(resolveEffectivePlan(subscription, now)).toBe('pro');
    expect(resolveEffectivePlan(subscription, new Date('2026-08-19T12:00:00.000Z'))).toBe('free');
  });

  it('shows Free outside the paid subscription period', () => {
    expect(
      resolveEffectivePlan(
        {
          cancel_at_period_end: false,
          current_period_end: '2026-08-01T00:00:00.000Z',
          current_period_start: '2026-07-01T00:00:00.000Z',
          grace_period_end: null,
          plan_code: 'pro',
          status: 'active',
        },
        now,
      ),
    ).toBe('free');
  });

  it('maps billing lifecycle states to the allowed account actions', () => {
    expect(
      resolveBillingPresentation(
        {
          cancel_at_period_end: false,
          current_period_end: null,
          current_period_start: null,
          grace_period_end: null,
          plan_code: 'free',
          status: 'incomplete',
        },
        now,
      ),
    ).toMatchObject({
      canCheckout: false,
      canOpenPortal: false,
      message: 'Payment processing. Your plan will update after Stripe confirms payment.',
    });

    expect(
      resolveBillingPresentation(
        {
          cancel_at_period_end: false,
          current_period_end: '2026-09-01T00:00:00.000Z',
          current_period_start: '2026-08-01T00:00:00.000Z',
          grace_period_end: '2026-08-18T12:00:00.000Z',
          plan_code: 'pro',
          status: 'past_due',
        },
        now,
      ),
    ).toMatchObject({
      canCheckout: false,
      canOpenPortal: true,
      message: expect.stringContaining('Payment failed'),
    });

    expect(
      resolveBillingPresentation(
        {
          cancel_at_period_end: false,
          current_period_end: '2026-08-01T00:00:00.000Z',
          current_period_start: '2026-07-01T00:00:00.000Z',
          grace_period_end: null,
          plan_code: 'pro',
          status: 'canceled',
        },
        now,
      ),
    ).toMatchObject({
      canCheckout: true,
      canOpenPortal: false,
    });
  });
});
