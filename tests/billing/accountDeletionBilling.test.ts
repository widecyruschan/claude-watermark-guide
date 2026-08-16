import { describe, expect, it, vi } from 'vitest';

import {
  cancelSubscriptionBeforeAccountDeletion,
  deleteAccountAfterBillingCleanup,
} from '../../src/account/supabaseAccountDeletionGateway';
import { AccountDeletionError } from '../../src/rewrite/rewriteService';

describe('account deletion billing cleanup', () => {
  it('cancels an active Stripe subscription before account deletion', async () => {
    const cancelSubscription = vi.fn().mockResolvedValue(undefined);

    await cancelSubscriptionBeforeAccountDeletion(
      { cancelSubscription },
      { status: 'active', subscriptionId: 'sub_test_member' },
    );

    expect(cancelSubscription).toHaveBeenCalledWith('sub_test_member');
  });

  it('refuses deletion when a billable subscription cannot be canceled', async () => {
    await expect(
      cancelSubscriptionBeforeAccountDeletion(null, {
        status: 'past_due',
        subscriptionId: 'sub_test_member',
      }),
    ).rejects.toEqual(new AccountDeletionError('ACCOUNT_DELETE_UNAVAILABLE'));
  });

  it('does not require Stripe for Free or already canceled accounts', async () => {
    await expect(
      cancelSubscriptionBeforeAccountDeletion(null, {
        status: 'inactive',
        subscriptionId: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('cancels billing before anonymizing and deleting the Auth user', async () => {
    const calls: string[] = [];

    await deleteAccountAfterBillingCleanup(
      {
        cancelSubscription: vi.fn().mockImplementation(async () => {
          calls.push('cancel');
        }),
      },
      { status: 'active', subscriptionId: 'sub_test_member' },
      async () => {
        calls.push('anonymize');
      },
      async () => {
        calls.push('delete');
      },
    );

    expect(calls).toEqual(['cancel', 'anonymize', 'delete']);
  });

  it('does not delete member data when Stripe cancellation fails', async () => {
    const anonymizeAccount = vi.fn();
    const deleteAuthUser = vi.fn();

    await expect(
      deleteAccountAfterBillingCleanup(
        { cancelSubscription: vi.fn().mockRejectedValue(new Error('fixture failure')) },
        { status: 'active', subscriptionId: 'sub_test_member' },
        anonymizeAccount,
        deleteAuthUser,
      ),
    ).rejects.toEqual(new AccountDeletionError('ACCOUNT_DELETE_UNAVAILABLE'));

    expect(anonymizeAccount).not.toHaveBeenCalled();
    expect(deleteAuthUser).not.toHaveBeenCalled();
  });
});
