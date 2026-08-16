import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import { StripeBillingProvider } from '../../src/billing/stripeBillingProvider';

describe('Stripe billing provider', () => {
  it('verifies and normalizes a signed subscription update without retaining its payload', async () => {
    const webhookSecret = 'whsec_fixture_only_not_a_real_secret';
    const payload = JSON.stringify({
      api_version: '2026-08-15.clover',
      created: 1_787_000_000,
      data: {
        object: {
          cancel_at_period_end: false,
          customer: 'cus_test_member',
          id: 'sub_test_member',
          items: {
            data: [
              {
                current_period_end: 1_789_678_400,
                current_period_start: 1_787_000_000,
                price: { id: 'price_test_pro_monthly' },
              },
            ],
          },
          metadata: { user_id: '10000000-0000-4000-8000-000000000001' },
          object: 'subscription',
          status: 'active',
        },
      },
      id: 'evt_test_subscription_update',
      livemode: false,
      object: 'event',
      pending_webhooks: 1,
      request: null,
      type: 'customer.subscription.updated',
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
    });
    const provider = new StripeBillingProvider('sk_test_fixture_only_not_a_real_secret');

    await expect(provider.verifyWebhook(payload, signature, webhookSecret)).resolves.toEqual({
      cancelAtPeriodEnd: false,
      checkoutSessionId: null,
      customerId: 'cus_test_member',
      eventCreatedAt: new Date(1_787_000_000 * 1000).toISOString(),
      eventId: 'evt_test_subscription_update',
      eventType: 'customer.subscription.updated',
      gracePeriodEnd: null,
      periodEnd: new Date(1_789_678_400 * 1000).toISOString(),
      periodStart: new Date(1_787_000_000 * 1000).toISOString(),
      priceId: 'price_test_pro_monthly',
      status: 'active',
      subscriptionId: 'sub_test_member',
      userId: '10000000-0000-4000-8000-000000000001',
    });
  });
});
