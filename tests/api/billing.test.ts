import { describe, expect, it, vi } from 'vitest';

import { createApiApp } from '../../src/api/app';
import { BillingError, type BillingRuntime } from '../../src/billing/billingService';

const bindings = {
  APP_BASE_URL: 'https://watermarklens.com',
  EBOND_API_KEY: 'provider-key-must-not-leak',
  EBOND_BASE_URL: 'https://api.ebondai.com',
  EBOND_MODEL: 'gpt-5.5',
  STRIPE_PRO_PRICE_ID: 'price_test_pro_monthly',
  STRIPE_SECRET_KEY: 'stripe-secret-must-not-leak',
  STRIPE_WEBHOOK_SECRET: 'webhook-secret-must-not-leak',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test-fixture-key-long-enough',
  SUPABASE_SERVICE_ROLE_KEY: 'database-key-must-not-leak',
  SUPABASE_URL: 'https://example.supabase.co',
};

function createBillingRuntime(): BillingRuntime {
  return {
    authenticator: {
      authenticate: vi.fn().mockResolvedValue({
        email: 'member@example.test',
        userId: '10000000-0000-4000-8000-000000000001',
      }),
    },
    provider: {
      cancelSubscription: vi.fn(),
      createCheckoutSession: vi.fn().mockResolvedValue({
        customerId: null,
        id: 'cs_test_allowed',
        url: 'https://checkout.stripe.com/c/pay/test-session',
      }),
      createPortalSession: vi.fn(),
      verifyWebhook: vi.fn(),
    },
    repository: {
      getBillingAccount: vi.fn().mockResolvedValue({
        currentPeriodEnd: null,
        customerId: null,
        gracePeriodEnd: null,
        profileStatus: 'active',
        status: 'inactive',
      }),
      markCheckoutPending: vi.fn().mockResolvedValue(undefined),
      processWebhookEvent: vi.fn(),
    },
  };
}

describe('Stripe billing API', () => {
  it('creates a server-mapped Pro Checkout Session for an authenticated member', async () => {
    const runtime = createBillingRuntime();
    const app = createApiApp({ billingRuntimeFactory: () => runtime });
    const response = await app.request(
      new Request('https://watermarklens.com/api/v1/billing/checkout', {
        body: '{}',
        headers: {
          authorization: 'Bearer member-jwt-must-not-leak',
          'content-type': 'application/json',
          'idempotency-key': '20000000-0000-4000-8000-000000000001',
        },
        method: 'POST',
      }),
      undefined,
      bindings,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { url: 'https://checkout.stripe.com/c/pay/test-session' },
      success: true,
    });
    expect(runtime.provider.createCheckoutSession).toHaveBeenCalledWith({
      appBaseUrl: 'https://watermarklens.com',
      customerId: null,
      email: 'member@example.test',
      idempotencyKey: '20000000-0000-4000-8000-000000000001',
      priceId: 'price_test_pro_monthly',
      userId: '10000000-0000-4000-8000-000000000001',
    });
    expect(runtime.repository.markCheckoutPending).toHaveBeenCalledWith({
      checkoutSessionId: 'cs_test_allowed',
      customerId: null,
      priceId: 'price_test_pro_monthly',
      userId: '10000000-0000-4000-8000-000000000001',
    });
  });

  it('rejects browser-selected Price IDs and redirect destinations', async () => {
    const runtime = createBillingRuntime();
    const app = createApiApp({ billingRuntimeFactory: () => runtime });
    const response = await app.request(
      new Request('https://watermarklens.com/api/v1/billing/checkout', {
        body: JSON.stringify({
          priceId: 'price_attacker_selected',
          successUrl: 'https://attacker.example/paid',
        }),
        headers: {
          authorization: 'Bearer member-jwt-must-not-leak',
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        method: 'POST',
      }),
      undefined,
      bindings,
    );

    expect(response.status).toBe(422);
    expect(runtime.provider.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects oversized billing command bodies before authentication', async () => {
    const runtime = createBillingRuntime();
    const app = createApiApp({ billingRuntimeFactory: () => runtime });
    const response = await app.request(
      new Request('https://watermarklens.com/api/v1/billing/checkout', {
        body: JSON.stringify({ padding: 'x'.repeat(2000) }),
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        method: 'POST',
      }),
      undefined,
      bindings,
    );

    expect(response.status).toBe(413);
    expect(runtime.authenticator.authenticate).not.toHaveBeenCalled();
  });

  it('requires an authenticated member for Checkout', async () => {
    const runtime = createBillingRuntime();
    vi.mocked(runtime.authenticator.authenticate).mockRejectedValue(
      new BillingError('AUTHENTICATION_REQUIRED'),
    );
    const app = createApiApp({ billingRuntimeFactory: () => runtime });
    const response = await app.request(
      new Request('https://watermarklens.com/api/v1/billing/checkout', {
        body: '{}',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        method: 'POST',
      }),
      undefined,
      bindings,
    );

    expect(response.status).toBe(401);
    expect(runtime.provider.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects a second Checkout while the first Session is pending', async () => {
    const runtime = createBillingRuntime();
    vi.mocked(runtime.repository.getBillingAccount).mockResolvedValue({
      currentPeriodEnd: null,
      customerId: null,
      gracePeriodEnd: null,
      profileStatus: 'active',
      status: 'incomplete',
    });
    const app = createApiApp({ billingRuntimeFactory: () => runtime });
    const response = await app.request(
      new Request('https://watermarklens.com/api/v1/billing/checkout', {
        body: '{}',
        headers: {
          authorization: 'Bearer member-jwt-must-not-leak',
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        method: 'POST',
      }),
      undefined,
      bindings,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'CHECKOUT_ALREADY_PENDING' },
      success: false,
    });
    expect(runtime.provider.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('creates a server-origin Customer Portal Session for a subscribed member', async () => {
    const runtime = createBillingRuntime();
    vi.mocked(runtime.repository.getBillingAccount).mockResolvedValue({
      currentPeriodEnd: '2030-01-01T00:00:00.000Z',
      customerId: 'cus_test_member',
      gracePeriodEnd: null,
      profileStatus: 'active',
      status: 'active',
    });
    vi.mocked(runtime.provider.createPortalSession).mockResolvedValue({
      url: 'https://billing.stripe.com/p/session/test-portal',
    });
    const app = createApiApp({ billingRuntimeFactory: () => runtime });
    const response = await app.request(
      new Request('https://watermarklens.com/api/v1/billing/portal', {
        body: '{}',
        headers: {
          authorization: 'Bearer member-jwt-must-not-leak',
          'content-type': 'application/json',
        },
        method: 'POST',
      }),
      undefined,
      bindings,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { url: 'https://billing.stripe.com/p/session/test-portal' },
      success: true,
    });
    expect(runtime.provider.createPortalSession).toHaveBeenCalledWith({
      appBaseUrl: 'https://watermarklens.com',
      customerId: 'cus_test_member',
    });
  });

  it('does not open Customer Portal for a canceled Free member', async () => {
    const runtime = createBillingRuntime();
    vi.mocked(runtime.repository.getBillingAccount).mockResolvedValue({
      currentPeriodEnd: '2026-08-01T00:00:00.000Z',
      customerId: 'cus_test_member',
      gracePeriodEnd: null,
      profileStatus: 'active',
      status: 'canceled',
    });
    const app = createApiApp({ billingRuntimeFactory: () => runtime });
    const response = await app.request(
      new Request('https://watermarklens.com/api/v1/billing/portal', {
        body: '{}',
        headers: {
          authorization: 'Bearer member-jwt-must-not-leak',
          'content-type': 'application/json',
        },
        method: 'POST',
      }),
      undefined,
      bindings,
    );

    expect(response.status).toBe(403);
    expect(runtime.provider.createPortalSession).not.toHaveBeenCalled();
  });

  it('verifies the raw Stripe payload before accepting an idempotent webhook replay', async () => {
    const runtime = createBillingRuntime();
    const payload = '{"id":"evt_test_replay","type":"customer.subscription.updated"}';
    vi.mocked(runtime.provider.verifyWebhook).mockResolvedValue({
      cancelAtPeriodEnd: false,
      checkoutSessionId: null,
      customerId: 'cus_test_member',
      eventCreatedAt: '2026-08-16T09:00:00.000Z',
      eventId: 'evt_test_replay',
      eventType: 'customer.subscription.updated',
      gracePeriodEnd: null,
      periodEnd: '2026-09-16T09:00:00.000Z',
      periodStart: '2026-08-16T09:00:00.000Z',
      priceId: 'price_test_pro_monthly',
      status: 'active',
      subscriptionId: 'sub_test_member',
      userId: '10000000-0000-4000-8000-000000000001',
    });
    vi.mocked(runtime.repository.processWebhookEvent).mockResolvedValue({ state: 'duplicate' });
    const app = createApiApp({ billingRuntimeFactory: () => runtime });
    const response = await app.request(
      new Request('https://watermarklens.com/api/v1/webhooks/stripe', {
        body: payload,
        headers: { 'stripe-signature': 't=fixture,v1=valid' },
        method: 'POST',
      }),
      undefined,
      bindings,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { state: 'duplicate' },
      success: true,
    });
    expect(runtime.provider.verifyWebhook).toHaveBeenCalledWith(
      payload,
      't=fixture,v1=valid',
      'webhook-secret-must-not-leak',
    );
    expect(runtime.repository.processWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'evt_test_replay',
        payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it('rejects an invalid webhook signature without exposing the signing secret', async () => {
    const runtime = createBillingRuntime();
    vi.mocked(runtime.provider.verifyWebhook).mockRejectedValue(
      new BillingError('WEBHOOK_SIGNATURE_INVALID'),
    );
    const app = createApiApp({ billingRuntimeFactory: () => runtime });
    const response = await app.request(
      new Request('https://watermarklens.com/api/v1/webhooks/stripe', {
        body: '{"id":"evt_invalid"}',
        headers: { 'stripe-signature': 'invalid' },
        method: 'POST',
      }),
      undefined,
      bindings,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'WEBHOOK_SIGNATURE_INVALID' } });
    expect(JSON.stringify(body)).not.toContain(bindings.STRIPE_WEBHOOK_SECRET);
    expect(runtime.repository.processWebhookEvent).not.toHaveBeenCalled();
  });
});
