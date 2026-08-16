import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import {
  BillingError,
  type BillingAccount,
  type BillingAuthenticator,
  type BillingRepository,
  type StoredBillingWebhookEvent,
} from './billingService';

const webhookResultSchema = z
  .array(
    z.object({
      event_state: z.enum(['applied', 'duplicate', 'ignored', 'stale']),
    }),
  )
  .length(1);

export class SupabaseBillingGateway implements BillingAuthenticator, BillingRepository {
  private readonly client: SupabaseClient;

  constructor(
    supabaseUrl: string,
    serviceRoleKey: string,
    private readonly allowedPriceId: string,
  ) {
    this.client = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });
  }

  async authenticate(
    authorizationHeader: string | undefined,
  ): Promise<{ email: string; userId: string }> {
    const tokenMatch = /^Bearer ([^\s]+)$/u.exec(authorizationHeader ?? '');

    if (!tokenMatch?.[1]) {
      throw new BillingError('AUTHENTICATION_REQUIRED');
    }

    const { data, error } = await this.client.auth.getUser(tokenMatch[1]);
    if (error || !data.user?.email) {
      throw new BillingError('AUTHENTICATION_REQUIRED');
    }

    return { email: data.user.email, userId: data.user.id };
  }

  async getBillingAccount(userId: string): Promise<BillingAccount> {
    const [profileResult, subscriptionResult] = await Promise.all([
      this.client.from('profiles').select('status').eq('id', userId).maybeSingle(),
      this.client
        .from('subscriptions')
        .select('status,stripe_customer_id,current_period_end,grace_period_end')
        .eq('user_id', userId)
        .maybeSingle(),
    ]);

    if (profileResult.error || subscriptionResult.error || !subscriptionResult.data) {
      throw new BillingError('BILLING_UNAVAILABLE');
    }

    return {
      currentPeriodEnd: subscriptionResult.data.current_period_end,
      customerId: subscriptionResult.data.stripe_customer_id,
      gracePeriodEnd: subscriptionResult.data.grace_period_end,
      profileStatus: profileResult.data?.status === 'active' ? 'active' : 'suspended',
      status: subscriptionResult.data.status,
    };
  }

  async markCheckoutPending(input: {
    checkoutSessionId: string;
    customerId: string | null;
    priceId: string;
    userId: string;
  }): Promise<void> {
    if (input.priceId !== this.allowedPriceId) {
      throw new BillingError('BILLING_CONFIGURATION_ERROR');
    }

    const { error } = await this.client.rpc('begin_stripe_checkout', {
      p_checkout_session_id: input.checkoutSessionId,
      p_customer_id: input.customerId,
      p_price_id: input.priceId,
      p_user_id: input.userId,
    });

    if (error) {
      if (error.message.includes('CHECKOUT_ALREADY_PENDING')) {
        throw new BillingError('CHECKOUT_ALREADY_PENDING');
      }
      if (error.message.includes('SUBSCRIPTION_ALREADY_ACTIVE')) {
        throw new BillingError('SUBSCRIPTION_ALREADY_ACTIVE');
      }
      if (error.message.includes('ACCOUNT_SUSPENDED')) {
        throw new BillingError('ACCOUNT_SUSPENDED');
      }
      throw new BillingError('BILLING_UNAVAILABLE');
    }
  }

  async processWebhookEvent(event: StoredBillingWebhookEvent) {
    if (
      event.eventType.startsWith('customer.subscription.') &&
      event.priceId !== this.allowedPriceId
    ) {
      throw new BillingError('WEBHOOK_PAYLOAD_INVALID');
    }

    const { data, error } = await this.client.rpc('process_stripe_webhook_event', {
      p_cancel_at_period_end: event.cancelAtPeriodEnd,
      p_checkout_session_id: event.checkoutSessionId,
      p_customer_id: event.customerId,
      p_event_created_at: event.eventCreatedAt,
      p_event_id: event.eventId,
      p_event_type: event.eventType,
      p_grace_period_end: event.gracePeriodEnd,
      p_payload_sha256: event.payloadSha256,
      p_period_end: event.periodEnd,
      p_period_start: event.periodStart,
      p_price_id: event.priceId,
      p_status: event.status,
      p_subscription_id: event.subscriptionId,
      p_user_id: event.userId,
    });

    if (error) {
      if (error.message.includes('INVALID_')) {
        throw new BillingError('WEBHOOK_PAYLOAD_INVALID');
      }
      throw new BillingError('BILLING_UNAVAILABLE');
    }

    const parsed = webhookResultSchema.safeParse(data);
    const result = parsed.success ? parsed.data[0] : null;
    if (!result) {
      throw new BillingError('BILLING_UNAVAILABLE');
    }

    return { state: result.event_state };
  }
}
