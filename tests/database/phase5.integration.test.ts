import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApiApp } from '../../src/api/app';

const supabaseUrl = process.env.SUPABASE_URL ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const hasDatabaseEnvironment = Boolean(supabaseUrl && anonKey && serviceRoleKey);

describe.skipIf(!hasDatabaseEnvironment)('Phase 5 Stripe billing lifecycle', () => {
  const createdUserIds = new Set<string>();
  let serviceClient: SupabaseClient;

  beforeAll(() => {
    serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });

  afterAll(async () => {
    await Promise.all(
      [...createdUserIds].map((userId) => serviceClient.auth.admin.deleteUser(userId)),
    );
  });

  async function createVerifiedMember(): Promise<{
    browserClient: SupabaseClient;
    userId: string;
  }> {
    const email = `billing-${crypto.randomUUID()}@example.test`;
    const password = `Test-${crypto.randomUUID()}`;
    const created = await serviceClient.auth.admin.createUser({
      email,
      email_confirm: true,
      password,
    });
    expect(created.error).toBeNull();
    const userId = created.data.user!.id;
    createdUserIds.add(userId);

    const browserClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    expect((await browserClient.auth.signInWithPassword({ email, password })).error).toBeNull();
    return { browserClient, userId };
  }

  async function applyStripeEvent(
    userId: string | null,
    input: {
      cancelAtPeriodEnd?: boolean | null;
      createdAt: Date;
      customerId: string;
      eventType: string;
      gracePeriodEnd?: Date | null;
      periodEnd?: Date | null;
      periodStart?: Date | null;
      priceId?: string | null;
      status?: string | null;
      subscriptionId: string;
    },
  ) {
    return serviceClient.rpc('process_stripe_webhook_event', {
      p_cancel_at_period_end: input.cancelAtPeriodEnd ?? null,
      p_checkout_session_id: null,
      p_customer_id: input.customerId,
      p_event_created_at: input.createdAt.toISOString(),
      p_event_id: `evt_${crypto.randomUUID().replaceAll('-', '')}`,
      p_event_type: input.eventType,
      p_grace_period_end: input.gracePeriodEnd?.toISOString() ?? null,
      p_payload_sha256: crypto.randomUUID().replaceAll('-', '').repeat(2),
      p_period_end: input.periodEnd?.toISOString() ?? null,
      p_period_start: input.periodStart?.toISOString() ?? null,
      p_price_id: input.priceId ?? null,
      p_status: input.status ?? null,
      p_subscription_id: input.subscriptionId,
      p_user_id: userId,
    });
  }

  async function completeStripeCheckout(input: {
    checkoutSessionId: string;
    createdAt: Date;
    customerId: string;
    subscriptionId: string;
    userId: string;
  }) {
    return serviceClient.rpc('process_stripe_webhook_event', {
      p_cancel_at_period_end: null,
      p_checkout_session_id: input.checkoutSessionId,
      p_customer_id: input.customerId,
      p_event_created_at: input.createdAt.toISOString(),
      p_event_id: `evt_${crypto.randomUUID().replaceAll('-', '')}`,
      p_event_type: 'checkout.session.completed',
      p_grace_period_end: null,
      p_payload_sha256: 'f'.repeat(64),
      p_period_end: null,
      p_period_start: null,
      p_price_id: null,
      p_status: 'incomplete',
      p_subscription_id: input.subscriptionId,
      p_user_id: input.userId,
    });
  }

  it('processes a signed Stripe event through the API and persists the subscription', async () => {
    const { userId } = await createVerifiedMember();
    const createdAt = Math.floor(Date.now() / 1000);
    const periodEnd = createdAt + 30 * 24 * 60 * 60;
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '')}`;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll('-', '')}`;
    const webhookSecret = 'whsec_fixture_only_not_a_real_secret';
    const payload = JSON.stringify({
      created: createdAt,
      data: {
        object: {
          cancel_at_period_end: false,
          customer: customerId,
          id: subscriptionId,
          items: {
            data: [
              {
                current_period_end: periodEnd,
                current_period_start: createdAt,
                price: { id: 'price_test_pro_monthly' },
              },
            ],
          },
          metadata: { user_id: userId },
          object: 'subscription',
          status: 'active',
        },
      },
      id: `evt_${crypto.randomUUID().replaceAll('-', '')}`,
      object: 'event',
      type: 'customer.subscription.created',
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
    });
    const app = createApiApp();
    const response = await app.request(
      new Request('https://watermarklens.com/api/v1/webhooks/stripe', {
        body: payload,
        headers: { 'stripe-signature': signature },
        method: 'POST',
      }),
      undefined,
      {
        APP_BASE_URL: 'https://watermarklens.com',
        REWRITE_API_KEY: 'fixture-not-used',
        REWRITE_BASE_URL: 'https://breakout.wenwen-ai.com',
        REWRITE_MODEL: 'gpt-5.5',
        STRIPE_PRO_PRICE_ID: 'price_test_pro_monthly',
        STRIPE_SECRET_KEY: 'sk_test_fixture_only_not_a_real_secret',
        STRIPE_WEBHOOK_SECRET: webhookSecret,
        SUPABASE_PUBLISHABLE_KEY: anonKey,
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
        SUPABASE_URL: supabaseUrl,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { state: 'applied' },
      success: true,
    });
    const subscription = await serviceClient
      .from('subscriptions')
      .select('status,stripe_customer_id,stripe_subscription_id')
      .eq('user_id', userId)
      .single();
    expect(subscription.data).toEqual({
      status: 'active',
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
    });
  });

  it('applies a subscription event once and treats a replay as a no-op', async () => {
    const { browserClient, userId } = await createVerifiedMember();
    const eventId = `evt_${crypto.randomUUID().replaceAll('-', '')}`;
    const eventCreatedAt = new Date();
    const periodEnd = new Date(eventCreatedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    const eventArguments = {
      p_cancel_at_period_end: false,
      p_checkout_session_id: null,
      p_customer_id: `cus_${crypto.randomUUID().replaceAll('-', '')}`,
      p_event_created_at: eventCreatedAt.toISOString(),
      p_event_id: eventId,
      p_event_type: 'customer.subscription.updated',
      p_grace_period_end: null,
      p_payload_sha256: 'a'.repeat(64),
      p_period_end: periodEnd.toISOString(),
      p_period_start: eventCreatedAt.toISOString(),
      p_price_id: 'price_test_pro_monthly',
      p_status: 'active',
      p_subscription_id: `sub_${crypto.randomUUID().replaceAll('-', '')}`,
      p_user_id: userId,
    };
    const checkoutArguments = {
      p_checkout_session_id: `cs_test_${crypto.randomUUID().replaceAll('-', '')}`,
      p_customer_id: null,
      p_price_id: 'price_test_pro_monthly',
      p_user_id: userId,
    };

    const browserCheckout = await browserClient.rpc('begin_stripe_checkout', checkoutArguments);
    expect(browserCheckout.error?.code).toBe('42501');
    const serverCheckout = await serviceClient.rpc('begin_stripe_checkout', checkoutArguments);
    expect(serverCheckout.error).toBeNull();
    expect(
      (
        await completeStripeCheckout({
          checkoutSessionId: checkoutArguments.p_checkout_session_id,
          createdAt: new Date(eventCreatedAt.getTime() + 1000),
          customerId: eventArguments.p_customer_id,
          subscriptionId: eventArguments.p_subscription_id,
          userId,
        })
      ).error,
    ).toBeNull();

    const first = await serviceClient.rpc('process_stripe_webhook_event', eventArguments);
    const replay = await serviceClient.rpc('process_stripe_webhook_event', eventArguments);

    expect(first.error).toBeNull();
    expect(first.data).toEqual([{ event_state: 'applied' }]);
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual([{ event_state: 'duplicate' }]);
    const stale = await serviceClient.rpc('process_stripe_webhook_event', {
      ...eventArguments,
      p_event_created_at: new Date(eventCreatedAt.getTime() - 60_000).toISOString(),
      p_event_id: `evt_${crypto.randomUUID().replaceAll('-', '')}`,
      p_status: 'canceled',
    });
    expect(stale.error).toBeNull();
    expect(stale.data).toEqual([{ event_state: 'stale' }]);

    const subscription = await serviceClient
      .from('subscriptions')
      .select(
        'plan_code,status,stripe_customer_id,stripe_subscription_id,stripe_price_id,current_period_end',
      )
      .eq('user_id', userId)
      .single();
    expect(subscription.error).toBeNull();
    expect(subscription.data).toMatchObject({
      plan_code: 'pro',
      status: 'active',
      stripe_price_id: 'price_test_pro_monthly',
    });

    const events = await serviceClient
      .from('webhook_events')
      .select('provider_event_id,status,payload_sha256')
      .eq('provider_event_id', eventId);
    expect(events.error).toBeNull();
    expect(events.data).toEqual([
      {
        payload_sha256: 'a'.repeat(64),
        provider_event_id: eventId,
        status: 'processed',
      },
    ]);
  });

  it('allows an idempotent Checkout marker but rejects a second pending Session', async () => {
    const { userId } = await createVerifiedMember();
    const firstSessionId = `cs_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const checkoutArguments = {
      p_checkout_session_id: firstSessionId,
      p_customer_id: null,
      p_price_id: 'price_test_pro_monthly',
      p_user_id: userId,
    };

    expect((await serviceClient.rpc('begin_stripe_checkout', checkoutArguments)).error).toBeNull();
    expect((await serviceClient.rpc('begin_stripe_checkout', checkoutArguments)).error).toBeNull();

    const competingCheckout = await serviceClient.rpc('begin_stripe_checkout', {
      ...checkoutArguments,
      p_checkout_session_id: `cs_test_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    expect(competingCheckout.error?.message).toContain('CHECKOUT_ALREADY_PENDING');

    const subscription = await serviceClient
      .from('subscriptions')
      .select('status,stripe_checkout_session_id')
      .eq('user_id', userId)
      .single();
    expect(subscription.data).toEqual({
      status: 'incomplete',
      stripe_checkout_session_id: firstSessionId,
    });
  });

  it('keeps Pro through period-end cancellation and the three-day past-due grace period', async () => {
    const { userId } = await createVerifiedMember();
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '')}`;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll('-', '')}`;
    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const active = await applyStripeEvent(userId, {
      cancelAtPeriodEnd: true,
      createdAt: periodStart,
      customerId,
      eventType: 'customer.subscription.updated',
      periodEnd,
      periodStart,
      priceId: 'price_test_pro_monthly',
      status: 'active',
      subscriptionId,
    });
    expect(active.error).toBeNull();

    const failedAt = new Date();
    const paymentFailed = await applyStripeEvent(null, {
      createdAt: failedAt,
      customerId,
      eventType: 'invoice.payment_failed',
      gracePeriodEnd: new Date(failedAt.getTime() + 3 * 24 * 60 * 60 * 1000),
      subscriptionId,
    });
    expect(paymentFailed.error).toBeNull();

    const requestId = crypto.randomUUID();
    const reservation = await serviceClient.rpc('reserve_quota', {
      p_input_characters: 15_000,
      p_request_id: requestId,
      p_user_id: userId,
    });
    expect(reservation.error).toBeNull();
    expect(
      (
        await serviceClient.rpc('release_quota', {
          p_request_id: requestId,
          p_user_id: userId,
        })
      ).error,
    ).toBeNull();
  });

  it('does not extend grace when Stripe repeats a payment failure', async () => {
    const { userId } = await createVerifiedMember();
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '')}`;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll('-', '')}`;
    const activeAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const firstFailureAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const secondFailureAt = new Date(Date.now() - 60 * 60 * 1000);
    const firstGraceEnd = new Date(firstFailureAt.getTime() + 3 * 24 * 60 * 60 * 1000);

    expect(
      (
        await applyStripeEvent(userId, {
          createdAt: activeAt,
          customerId,
          eventType: 'customer.subscription.updated',
          periodEnd: new Date(activeAt.getTime() + 30 * 24 * 60 * 60 * 1000),
          periodStart: activeAt,
          priceId: 'price_test_pro_monthly',
          status: 'active',
          subscriptionId,
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await applyStripeEvent(null, {
          createdAt: firstFailureAt,
          customerId,
          eventType: 'invoice.payment_failed',
          gracePeriodEnd: firstGraceEnd,
          subscriptionId,
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await applyStripeEvent(null, {
          createdAt: secondFailureAt,
          customerId,
          eventType: 'invoice.payment_failed',
          gracePeriodEnd: new Date(secondFailureAt.getTime() + 3 * 24 * 60 * 60 * 1000),
          subscriptionId,
        })
      ).error,
    ).toBeNull();

    const subscription = await serviceClient
      .from('subscriptions')
      .select('status,grace_period_end')
      .eq('user_id', userId)
      .single();
    expect(subscription.data?.status).toBe('past_due');
    expect(new Date(subscription.data!.grace_period_end).toISOString()).toBe(
      firstGraceEnd.toISOString(),
    );
  });

  it('falls back to Free limits after the past-due grace period expires', async () => {
    const { userId } = await createVerifiedMember();
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '')}`;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll('-', '')}`;
    const activeAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const failedAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    const periodEnd = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000);
    expect(
      (
        await applyStripeEvent(userId, {
          cancelAtPeriodEnd: false,
          createdAt: activeAt,
          customerId,
          eventType: 'customer.subscription.updated',
          periodEnd,
          periodStart: activeAt,
          priceId: 'price_test_pro_monthly',
          status: 'active',
          subscriptionId,
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await applyStripeEvent(null, {
          createdAt: failedAt,
          customerId,
          eventType: 'invoice.payment_failed',
          gracePeriodEnd: new Date(failedAt.getTime() + 3 * 24 * 60 * 60 * 1000),
          subscriptionId,
        })
      ).error,
    ).toBeNull();

    const reservation = await serviceClient.rpc('reserve_quota', {
      p_input_characters: 15_000,
      p_request_id: crypto.randomUUID(),
      p_user_id: userId,
    });
    expect(reservation.error?.message).toContain('REQUEST_LIMIT_EXCEEDED');
  });

  it('does not let Checkout delivery order suppress the canonical Subscription event', async () => {
    const { userId } = await createVerifiedMember();
    const checkoutSessionId = `cs_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '')}`;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll('-', '')}`;
    expect(
      (
        await serviceClient.rpc('begin_stripe_checkout', {
          p_checkout_session_id: checkoutSessionId,
          p_customer_id: null,
          p_price_id: 'price_test_pro_monthly',
          p_user_id: userId,
        })
      ).error,
    ).toBeNull();

    const checkoutCreatedAt = new Date();
    const subscriptionCreatedAt = new Date(checkoutCreatedAt.getTime() - 1000);
    const subscriptionArguments = {
      p_cancel_at_period_end: false,
      p_checkout_session_id: null,
      p_customer_id: customerId,
      p_event_created_at: subscriptionCreatedAt.toISOString(),
      p_event_id: `evt_${crypto.randomUUID().replaceAll('-', '')}`,
      p_event_type: 'customer.subscription.created',
      p_grace_period_end: null,
      p_payload_sha256: 'e'.repeat(64),
      p_period_end: new Date(checkoutCreatedAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      p_period_start: subscriptionCreatedAt.toISOString(),
      p_price_id: 'price_test_pro_monthly',
      p_status: 'active',
      p_subscription_id: subscriptionId,
      p_user_id: userId,
    };
    const earlySubscription = await serviceClient.rpc(
      'process_stripe_webhook_event',
      subscriptionArguments,
    );
    expect(earlySubscription.error?.message).toContain('CHECKOUT_NOT_READY');

    const checkout = await serviceClient.rpc('process_stripe_webhook_event', {
      p_cancel_at_period_end: null,
      p_checkout_session_id: checkoutSessionId,
      p_customer_id: customerId,
      p_event_created_at: checkoutCreatedAt.toISOString(),
      p_event_id: `evt_${crypto.randomUUID().replaceAll('-', '')}`,
      p_event_type: 'checkout.session.completed',
      p_grace_period_end: null,
      p_payload_sha256: 'c'.repeat(64),
      p_period_end: null,
      p_period_start: null,
      p_price_id: null,
      p_status: 'incomplete',
      p_subscription_id: subscriptionId,
      p_user_id: userId,
    });
    expect(checkout.error).toBeNull();

    const subscription = await serviceClient.rpc(
      'process_stripe_webhook_event',
      subscriptionArguments,
    );
    expect(subscription.error).toBeNull();
    expect(subscription.data).toEqual([{ event_state: 'applied' }]);
  });

  it('ignores an expired event from an older Checkout Session', async () => {
    const { userId } = await createVerifiedMember();
    const oldSessionId = `cs_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const newSessionId = `cs_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '')}`;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll('-', '')}`;
    const oldCheckoutArguments = {
      p_checkout_session_id: oldSessionId,
      p_customer_id: null,
      p_price_id: 'price_test_pro_monthly',
      p_user_id: userId,
    };
    expect(
      (await serviceClient.rpc('begin_stripe_checkout', oldCheckoutArguments)).error,
    ).toBeNull();

    const expiredArguments = {
      p_cancel_at_period_end: null,
      p_checkout_session_id: oldSessionId,
      p_customer_id: null,
      p_event_created_at: new Date(Date.now() - 4_000).toISOString(),
      p_event_id: `evt_${crypto.randomUUID().replaceAll('-', '')}`,
      p_event_type: 'checkout.session.expired',
      p_grace_period_end: null,
      p_payload_sha256: 'd'.repeat(64),
      p_period_end: null,
      p_period_start: null,
      p_price_id: null,
      p_status: 'incomplete_expired',
      p_subscription_id: null,
      p_user_id: userId,
    };
    expect(
      (await serviceClient.rpc('process_stripe_webhook_event', expiredArguments)).error,
    ).toBeNull();

    expect(
      (
        await serviceClient.rpc('begin_stripe_checkout', {
          ...oldCheckoutArguments,
          p_checkout_session_id: newSessionId,
        })
      ).error,
    ).toBeNull();
    const activeAt = new Date(Date.now() - 1_000);
    expect(
      (
        await completeStripeCheckout({
          checkoutSessionId: newSessionId,
          createdAt: new Date(activeAt.getTime() - 500),
          customerId,
          subscriptionId,
          userId,
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await applyStripeEvent(userId, {
          createdAt: activeAt,
          customerId,
          eventType: 'customer.subscription.created',
          periodEnd: new Date(activeAt.getTime() + 30 * 24 * 60 * 60 * 1000),
          periodStart: activeAt,
          priceId: 'price_test_pro_monthly',
          status: 'active',
          subscriptionId,
        })
      ).error,
    ).toBeNull();

    const delayedOldEvent = await serviceClient.rpc('process_stripe_webhook_event', {
      ...expiredArguments,
      p_event_created_at: new Date().toISOString(),
      p_event_id: `evt_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    expect(delayedOldEvent.error).toBeNull();
    expect(delayedOldEvent.data).toEqual([{ event_state: 'ignored' }]);

    const subscription = await serviceClient
      .from('subscriptions')
      .select('status,stripe_subscription_id,stripe_checkout_session_id')
      .eq('user_id', userId)
      .single();
    expect(subscription.data).toEqual({
      status: 'active',
      stripe_checkout_session_id: newSessionId,
      stripe_subscription_id: subscriptionId,
    });
  });

  it('ignores a deletion event from a replaced Stripe Subscription', async () => {
    const { userId } = await createVerifiedMember();
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '')}`;
    const oldSubscriptionId = `sub_${crypto.randomUUID().replaceAll('-', '')}`;
    const newSubscriptionId = `sub_${crypto.randomUUID().replaceAll('-', '')}`;
    const oldActiveAt = new Date(Date.now() - 5_000);
    const oldPeriodEnd = new Date(oldActiveAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(
      (
        await applyStripeEvent(userId, {
          createdAt: oldActiveAt,
          customerId,
          eventType: 'customer.subscription.created',
          periodEnd: oldPeriodEnd,
          periodStart: oldActiveAt,
          priceId: 'price_test_pro_monthly',
          status: 'active',
          subscriptionId: oldSubscriptionId,
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await applyStripeEvent(null, {
          createdAt: new Date(Date.now() - 4_000),
          customerId,
          eventType: 'customer.subscription.deleted',
          periodEnd: oldPeriodEnd,
          periodStart: oldActiveAt,
          priceId: 'price_test_pro_monthly',
          status: 'canceled',
          subscriptionId: oldSubscriptionId,
        })
      ).error,
    ).toBeNull();
    const failedAfterCancellation = await applyStripeEvent(null, {
      createdAt: new Date(Date.now() - 3_500),
      customerId,
      eventType: 'invoice.payment_failed',
      gracePeriodEnd: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      subscriptionId: oldSubscriptionId,
    });
    expect(failedAfterCancellation.error).toBeNull();
    expect(
      (
        await serviceClient
          .from('subscriptions')
          .select('status,grace_period_end')
          .eq('user_id', userId)
          .single()
      ).data,
    ).toEqual({ grace_period_end: null, status: 'canceled' });
    expect(
      (
        await serviceClient.rpc('begin_stripe_checkout', {
          p_checkout_session_id: `cs_test_${crypto.randomUUID().replaceAll('-', '')}`,
          p_customer_id: customerId,
          p_price_id: 'price_test_pro_monthly',
          p_user_id: userId,
        })
      ).error,
    ).toBeNull();

    const newActiveAt = new Date(Date.now() - 2_000);
    const newCheckoutSession = await serviceClient
      .from('subscriptions')
      .select('stripe_checkout_session_id')
      .eq('user_id', userId)
      .single();
    expect(newCheckoutSession.error).toBeNull();
    expect(
      (
        await completeStripeCheckout({
          checkoutSessionId: newCheckoutSession.data!.stripe_checkout_session_id,
          createdAt: new Date(newActiveAt.getTime() - 500),
          customerId,
          subscriptionId: newSubscriptionId,
          userId,
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await applyStripeEvent(userId, {
          createdAt: newActiveAt,
          customerId,
          eventType: 'customer.subscription.created',
          periodEnd: new Date(newActiveAt.getTime() + 30 * 24 * 60 * 60 * 1000),
          periodStart: newActiveAt,
          priceId: 'price_test_pro_monthly',
          status: 'active',
          subscriptionId: newSubscriptionId,
        })
      ).error,
    ).toBeNull();

    const delayedDeletion = await applyStripeEvent(userId, {
      createdAt: new Date(),
      customerId,
      eventType: 'customer.subscription.deleted',
      periodEnd: oldPeriodEnd,
      periodStart: oldActiveAt,
      priceId: 'price_test_pro_monthly',
      status: 'canceled',
      subscriptionId: oldSubscriptionId,
    });
    expect(delayedDeletion.error).toBeNull();
    expect(delayedDeletion.data).toEqual([{ event_state: 'ignored' }]);

    const subscription = await serviceClient
      .from('subscriptions')
      .select('status,stripe_subscription_id')
      .eq('user_id', userId)
      .single();
    expect(subscription.data).toEqual({
      status: 'active',
      stripe_subscription_id: newSubscriptionId,
    });
  });

  it('updates renewal dates without overriding a newer Invoice status', async () => {
    const { userId } = await createVerifiedMember();
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '')}`;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll('-', '')}`;
    const firstSubscriptionAt = new Date(Date.now() - 3_000);
    const renewalSubscriptionAt = new Date(Date.now() - 2_000);
    const invoicePaidAt = new Date(Date.now() - 1_000);
    const renewedPeriodEnd = new Date(renewalSubscriptionAt.getTime() + 30 * 24 * 60 * 60 * 1000);

    expect(
      (
        await applyStripeEvent(userId, {
          createdAt: firstSubscriptionAt,
          customerId,
          eventType: 'customer.subscription.created',
          periodEnd: renewalSubscriptionAt,
          periodStart: firstSubscriptionAt,
          priceId: 'price_test_pro_monthly',
          status: 'active',
          subscriptionId,
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await applyStripeEvent(null, {
          createdAt: invoicePaidAt,
          customerId,
          eventType: 'invoice.paid',
          subscriptionId,
        })
      ).error,
    ).toBeNull();

    const delayedRenewal = await applyStripeEvent(null, {
      createdAt: renewalSubscriptionAt,
      customerId,
      eventType: 'customer.subscription.updated',
      periodEnd: renewedPeriodEnd,
      periodStart: renewalSubscriptionAt,
      priceId: 'price_test_pro_monthly',
      status: 'past_due',
      subscriptionId,
    });
    expect(delayedRenewal.error).toBeNull();
    expect(delayedRenewal.data).toEqual([{ event_state: 'applied' }]);

    const subscription = await serviceClient
      .from('subscriptions')
      .select('status,current_period_end,grace_period_end')
      .eq('user_id', userId)
      .single();
    expect(subscription.data).toMatchObject({ grace_period_end: null, status: 'active' });
    expect(new Date(subscription.data!.current_period_end).toISOString()).toBe(
      renewedPeriodEnd.toISOString(),
    );
  });
});
