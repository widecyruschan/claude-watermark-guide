import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { BillingProvider } from '../billing/billingService';
import { AccountDeletionError, RewriteError } from '../rewrite/rewriteService';

const RECENT_AUTHENTICATION_WINDOW_MS = 10 * 60 * 1000;
const NON_BILLABLE_STATUSES = new Set(['inactive', 'incomplete_expired', 'canceled']);

export interface AccountDeletionGateway {
  deleteRecentlyAuthenticatedUser(
    authorizationHeader: string | undefined,
    requestId: string,
  ): Promise<void>;
}

export async function cancelSubscriptionBeforeAccountDeletion(
  canceller: Pick<BillingProvider, 'cancelSubscription'> | null,
  subscription: { status: string; subscriptionId: string | null },
): Promise<void> {
  if (!subscription.subscriptionId || NON_BILLABLE_STATUSES.has(subscription.status)) {
    return;
  }
  if (!canceller) {
    throw new AccountDeletionError('ACCOUNT_DELETE_UNAVAILABLE');
  }

  try {
    await canceller.cancelSubscription(subscription.subscriptionId);
  } catch {
    throw new AccountDeletionError('ACCOUNT_DELETE_UNAVAILABLE');
  }
}

export async function deleteAccountAfterBillingCleanup(
  canceller: Pick<BillingProvider, 'cancelSubscription'> | null,
  subscription: { status: string; subscriptionId: string | null },
  anonymizeAccount: () => Promise<void>,
  deleteAuthUser: () => Promise<void>,
): Promise<void> {
  await cancelSubscriptionBeforeAccountDeletion(canceller, subscription);
  await anonymizeAccount();
  await deleteAuthUser();
}

export class SupabaseAccountDeletionGateway implements AccountDeletionGateway {
  private readonly client: SupabaseClient;

  constructor(
    supabaseUrl: string,
    serviceRoleKey: string,
    private readonly stripeCanceller: Pick<BillingProvider, 'cancelSubscription'> | null,
  ) {
    this.client = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });
  }

  async deleteRecentlyAuthenticatedUser(
    authorizationHeader: string | undefined,
    requestId: string,
  ): Promise<void> {
    const tokenMatch = /^Bearer ([^\s]+)$/u.exec(authorizationHeader ?? '');
    if (!tokenMatch?.[1]) {
      throw new RewriteError('AUTHENTICATION_REQUIRED');
    }

    const { data: userData, error: userError } = await this.client.auth.getUser(tokenMatch[1]);
    const lastSignInAt = userData.user?.last_sign_in_at;
    const lastSignInTime = lastSignInAt ? Date.parse(lastSignInAt) : Number.NaN;
    if (userError || !userData.user) {
      throw new RewriteError('AUTHENTICATION_REQUIRED');
    }
    if (
      !Number.isFinite(lastSignInTime) ||
      Date.now() - lastSignInTime > RECENT_AUTHENTICATION_WINDOW_MS
    ) {
      throw new AccountDeletionError('RECENT_AUTHENTICATION_REQUIRED');
    }

    const subscription = await this.client
      .from('subscriptions')
      .select('status,stripe_subscription_id')
      .eq('user_id', userData.user.id)
      .maybeSingle();
    if (subscription.error) {
      throw new AccountDeletionError('ACCOUNT_DELETE_UNAVAILABLE');
    }

    await deleteAccountAfterBillingCleanup(
      this.stripeCanceller,
      {
        status: subscription.data?.status ?? 'inactive',
        subscriptionId: subscription.data?.stripe_subscription_id ?? null,
      },
      async () => {
        const { error } = await this.client.rpc('anonymize_deleted_member', {
          p_request_id: requestId,
          p_user_id: userData.user!.id,
        });
        if (error) {
          throw new AccountDeletionError('ACCOUNT_DELETE_UNAVAILABLE');
        }
      },
      async () => {
        const { error } = await this.client.auth.admin.deleteUser(userData.user!.id, true);
        if (error) {
          throw new AccountDeletionError('ACCOUNT_DELETE_UNAVAILABLE');
        }
      },
    );
  }
}
