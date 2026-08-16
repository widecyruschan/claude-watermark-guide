export type BillingErrorCode =
  | 'ACCOUNT_SUSPENDED'
  | 'AUTHENTICATION_REQUIRED'
  | 'BILLING_CONFIGURATION_ERROR'
  | 'BILLING_UNAVAILABLE'
  | 'CHECKOUT_ALREADY_PENDING'
  | 'SUBSCRIPTION_ALREADY_ACTIVE'
  | 'SUBSCRIPTION_REQUIRED'
  | 'WEBHOOK_PAYLOAD_INVALID'
  | 'WEBHOOK_SIGNATURE_INVALID';

export class BillingError extends Error {
  constructor(readonly code: BillingErrorCode) {
    super(code);
    this.name = 'BillingError';
  }
}

export interface BillingAccount {
  currentPeriodEnd: string | null;
  customerId: string | null;
  gracePeriodEnd: string | null;
  profileStatus: 'active' | 'suspended';
  status: string;
}

export interface BillingAuthenticator {
  authenticate(authorizationHeader: string | undefined): Promise<{ email: string; userId: string }>;
}

export interface CheckoutSessionInput {
  appBaseUrl: string;
  customerId: string | null;
  email: string;
  idempotencyKey: string;
  priceId: string;
  userId: string;
}

export interface BillingWebhookEvent {
  cancelAtPeriodEnd: boolean | null;
  checkoutSessionId: string | null;
  customerId: string | null;
  eventCreatedAt: string;
  eventId: string;
  eventType: string;
  gracePeriodEnd: string | null;
  periodEnd: string | null;
  periodStart: string | null;
  priceId: string | null;
  status: string | null;
  subscriptionId: string | null;
  userId: string | null;
}

export interface StoredBillingWebhookEvent extends BillingWebhookEvent {
  payloadSha256: string;
}

export interface BillingProvider {
  cancelSubscription(subscriptionId: string): Promise<void>;
  createCheckoutSession(input: CheckoutSessionInput): Promise<{
    customerId: string | null;
    id: string;
    url: string;
  }>;
  createPortalSession(input: { appBaseUrl: string; customerId: string }): Promise<{ url: string }>;
  verifyWebhook(payload: string, signature: string, secret: string): Promise<BillingWebhookEvent>;
}

export interface BillingRepository {
  getBillingAccount(userId: string): Promise<BillingAccount>;
  markCheckoutPending(input: {
    checkoutSessionId: string;
    customerId: string | null;
    priceId: string;
    userId: string;
  }): Promise<void>;
  processWebhookEvent(
    event: StoredBillingWebhookEvent,
  ): Promise<{ state: 'applied' | 'duplicate' | 'ignored' | 'stale' }>;
}

export interface BillingRuntime {
  authenticator: BillingAuthenticator;
  provider: BillingProvider;
  repository: BillingRepository;
}

export async function createProCheckout(
  runtime: BillingRuntime,
  input: {
    appBaseUrl: string | undefined;
    authorizationHeader: string | undefined;
    idempotencyKey: string;
    priceId: string | undefined;
  },
): Promise<{ url: string }> {
  const appBaseUrl = parseAppBaseUrl(input.appBaseUrl);
  const priceId = parsePriceId(input.priceId);
  const member = await runtime.authenticator.authenticate(input.authorizationHeader);
  const account = await runtime.repository.getBillingAccount(member.userId);

  if (account.profileStatus !== 'active') {
    throw new BillingError('ACCOUNT_SUSPENDED');
  }

  if (account.status === 'incomplete') {
    throw new BillingError('CHECKOUT_ALREADY_PENDING');
  }

  if (['past_due', 'unpaid', 'paused'].includes(account.status)) {
    throw new BillingError('SUBSCRIPTION_ALREADY_ACTIVE');
  }

  if (hasPaidAccess(account)) {
    throw new BillingError('SUBSCRIPTION_ALREADY_ACTIVE');
  }

  let session: Awaited<ReturnType<BillingProvider['createCheckoutSession']>>;

  try {
    session = await runtime.provider.createCheckoutSession({
      appBaseUrl,
      customerId: account.customerId,
      email: member.email,
      idempotencyKey: input.idempotencyKey,
      priceId,
      userId: member.userId,
    });
    await runtime.repository.markCheckoutPending({
      checkoutSessionId: session.id,
      customerId: session.customerId,
      priceId,
      userId: member.userId,
    });
  } catch (error) {
    if (error instanceof BillingError) {
      throw error;
    }
    throw new BillingError('BILLING_UNAVAILABLE');
  }

  return { url: session.url };
}

export async function createBillingPortal(
  runtime: BillingRuntime,
  input: {
    appBaseUrl: string | undefined;
    authorizationHeader: string | undefined;
  },
): Promise<{ url: string }> {
  const appBaseUrl = parseAppBaseUrl(input.appBaseUrl);
  const member = await runtime.authenticator.authenticate(input.authorizationHeader);
  const account = await runtime.repository.getBillingAccount(member.userId);

  if (account.profileStatus !== 'active') {
    throw new BillingError('ACCOUNT_SUSPENDED');
  }

  if (!account.customerId) {
    throw new BillingError('SUBSCRIPTION_REQUIRED');
  }

  if (!['active', 'trialing', 'past_due', 'unpaid', 'paused'].includes(account.status)) {
    throw new BillingError('SUBSCRIPTION_REQUIRED');
  }

  try {
    return await runtime.provider.createPortalSession({
      appBaseUrl,
      customerId: account.customerId,
    });
  } catch (error) {
    if (error instanceof BillingError) {
      throw error;
    }
    throw new BillingError('BILLING_UNAVAILABLE');
  }
}

export async function processStripeWebhook(
  runtime: BillingRuntime,
  input: {
    payload: string;
    signature: string | undefined;
    webhookSecret: string | undefined;
  },
): Promise<{ state: 'applied' | 'duplicate' | 'ignored' | 'stale' }> {
  if (!input.signature) {
    throw new BillingError('WEBHOOK_SIGNATURE_INVALID');
  }
  if (!input.webhookSecret) {
    throw new BillingError('BILLING_CONFIGURATION_ERROR');
  }

  let event: BillingWebhookEvent;
  try {
    event = await runtime.provider.verifyWebhook(
      input.payload,
      input.signature,
      input.webhookSecret,
    );
  } catch (error) {
    if (error instanceof BillingError) {
      throw error;
    }
    throw new BillingError('WEBHOOK_SIGNATURE_INVALID');
  }

  try {
    return await runtime.repository.processWebhookEvent({
      ...event,
      payloadSha256: await createSha256(input.payload),
    });
  } catch (error) {
    if (error instanceof BillingError) {
      throw error;
    }
    throw new BillingError('BILLING_UNAVAILABLE');
  }
}

function parseAppBaseUrl(value: string | undefined): string {
  try {
    const url = new URL(value ?? '');
    if ((url.protocol !== 'https:' && url.hostname !== 'localhost') || url.origin !== value) {
      throw new Error('invalid origin');
    }
    return url.origin;
  } catch {
    throw new BillingError('BILLING_CONFIGURATION_ERROR');
  }
}

function parsePriceId(value: string | undefined): string {
  if (!value || !/^price_[A-Za-z0-9_]{8,}$/u.test(value)) {
    throw new BillingError('BILLING_CONFIGURATION_ERROR');
  }
  return value;
}

function hasPaidAccess(account: BillingAccount): boolean {
  const now = Date.now();
  const periodEnd = Date.parse(account.currentPeriodEnd ?? '');
  const graceEnd = Date.parse(account.gracePeriodEnd ?? '');

  if ((account.status === 'active' || account.status === 'trialing') && periodEnd > now) {
    return true;
  }

  return account.status === 'past_due' && periodEnd > now && graceEnd > now;
}

async function createSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
