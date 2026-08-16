import Stripe from 'stripe';

import {
  BillingError,
  type BillingProvider,
  type BillingWebhookEvent,
  type CheckoutSessionInput,
} from './billingService';

const GRACE_PERIOD_SECONDS = 3 * 24 * 60 * 60;

export class StripeBillingProvider implements BillingProvider {
  private readonly cryptoProvider = Stripe.createSubtleCryptoProvider();
  private readonly stripe: Stripe;

  constructor(apiKey: string) {
    this.stripe = new Stripe(apiKey, {
      httpClient: Stripe.createFetchHttpClient(),
    });
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.cancel(subscriptionId);
  }

  async createCheckoutSession(input: CheckoutSessionInput) {
    const customer = input.customerId
      ? { customer: input.customerId }
      : { customer_email: input.email };
    const session = await this.stripe.checkout.sessions.create(
      {
        ...customer,
        cancel_url: `${input.appBaseUrl}/account?checkout=cancelled`,
        client_reference_id: input.userId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        metadata: { plan_code: 'pro', user_id: input.userId },
        mode: 'subscription',
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        success_url: `${input.appBaseUrl}/account?checkout=success`,
        subscription_data: {
          metadata: { plan_code: 'pro', user_id: input.userId },
        },
      },
      { idempotencyKey: input.idempotencyKey },
    );

    if (!session.url) {
      throw new BillingError('BILLING_UNAVAILABLE');
    }

    return {
      customerId: getExpandableId(session.customer),
      id: session.id,
      url: session.url,
    };
  }

  async createPortalSession(input: { appBaseUrl: string; customerId: string }) {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: `${input.appBaseUrl}/account`,
    });
    return { url: session.url };
  }

  async verifyWebhook(
    payload: string,
    signature: string,
    secret: string,
  ): Promise<BillingWebhookEvent> {
    let event: Stripe.Event;

    try {
      event = await this.stripe.webhooks.constructEventAsync(
        payload,
        signature,
        secret,
        undefined,
        this.cryptoProvider,
      );
    } catch {
      throw new BillingError('WEBHOOK_SIGNATURE_INVALID');
    }

    return normalizeStripeEvent(event);
  }
}

function normalizeStripeEvent(event: Stripe.Event): BillingWebhookEvent {
  if (!event.id || !event.type || !Number.isInteger(event.created)) {
    throw new BillingError('WEBHOOK_PAYLOAD_INVALID');
  }

  const common = {
    cancelAtPeriodEnd: null,
    checkoutSessionId: null,
    customerId: null,
    eventCreatedAt: toIsoDate(event.created),
    eventId: event.id,
    eventType: event.type,
    gracePeriodEnd: null,
    periodEnd: null,
    periodStart: null,
    priceId: null,
    status: null,
    subscriptionId: null,
    userId: null,
  } satisfies BillingWebhookEvent;
  const object = asRecord(event.data.object);

  if (event.type.startsWith('customer.subscription.')) {
    const firstItem = getFirstSubscriptionItem(object);
    const status = getString(object, 'status');

    if (!status) {
      throw new BillingError('WEBHOOK_PAYLOAD_INVALID');
    }

    return {
      ...common,
      cancelAtPeriodEnd: getBoolean(object, 'cancel_at_period_end'),
      customerId: getExpandableId(object.customer),
      gracePeriodEnd:
        status === 'past_due' ? toIsoDate(event.created + GRACE_PERIOD_SECONDS) : null,
      periodEnd:
        getTimestamp(object, 'current_period_end') ?? getTimestamp(firstItem, 'current_period_end'),
      periodStart:
        getTimestamp(object, 'current_period_start') ??
        getTimestamp(firstItem, 'current_period_start'),
      priceId: getExpandableId(firstItem.price),
      status,
      subscriptionId: getString(object, 'id'),
      userId: getMetadataValue(object, 'user_id'),
    };
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.expired') {
    return {
      ...common,
      checkoutSessionId: getString(object, 'id'),
      customerId: getExpandableId(object.customer),
      status: event.type === 'checkout.session.expired' ? 'incomplete_expired' : 'incomplete',
      subscriptionId: getExpandableId(object.subscription),
      userId: getString(object, 'client_reference_id') ?? getMetadataValue(object, 'user_id'),
    };
  }

  if (event.type === 'invoice.payment_failed' || event.type === 'invoice.paid') {
    return {
      ...common,
      customerId: getExpandableId(object.customer),
      gracePeriodEnd:
        event.type === 'invoice.payment_failed'
          ? toIsoDate(event.created + GRACE_PERIOD_SECONDS)
          : null,
      status: event.type === 'invoice.payment_failed' ? 'past_due' : 'active',
      subscriptionId: getInvoiceSubscriptionId(object),
    };
  }

  return common;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function getString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value ? value : null;
}

function getBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === 'boolean' ? value : null;
}

function getExpandableId(value: unknown): string | null {
  if (typeof value === 'string' && value) {
    return value;
  }
  return getString(asRecord(value), 'id');
}

function getTimestamp(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) ? toIsoDate(value) : null;
}

function getMetadataValue(record: Record<string, unknown>, key: string): string | null {
  return getString(asRecord(record.metadata), key);
}

function getFirstSubscriptionItem(subscription: Record<string, unknown>): Record<string, unknown> {
  const items = asRecord(subscription.items);
  const data = Array.isArray(items.data) ? items.data : [];
  return asRecord(data[0]);
}

function getInvoiceSubscriptionId(invoice: Record<string, unknown>): string | null {
  const direct = getExpandableId(invoice.subscription);
  if (direct) {
    return direct;
  }

  const parent = asRecord(invoice.parent);
  const subscriptionDetails = asRecord(parent.subscription_details);
  return getExpandableId(subscriptionDetails.subscription);
}

function toIsoDate(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toISOString();
}
