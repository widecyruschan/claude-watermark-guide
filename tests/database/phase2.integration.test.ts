import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const magicLinkTestDomain = process.env.SUPABASE_TEST_EMAIL_DOMAIN ?? 'example.test';
const hasDatabaseEnvironment = Boolean(supabaseUrl && anonKey && serviceRoleKey);

function createBrowserClient(): SupabaseClient {
  return createClient(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

function createServiceClient(): SupabaseClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

describe.skipIf(!hasDatabaseEnvironment)('Phase 2 Supabase behavior', () => {
  const createdUserIds = new Set<string>();
  let serviceClient: SupabaseClient;

  beforeAll(() => {
    serviceClient = createServiceClient();
  });

  afterAll(async () => {
    const deletionResults = await Promise.all(
      [...createdUserIds].map((userId) => serviceClient.auth.admin.deleteUser(userId)),
    );

    for (const { error } of deletionResults) {
      expect(error).toBeNull();
    }
  });

  async function createVerifiedUser(label: string): Promise<{
    browserClient: SupabaseClient;
    user: User;
  }> {
    const email = `${label}-${crypto.randomUUID()}@example.test`;
    const password = `Test-${crypto.randomUUID()}`;
    const { data, error } = await serviceClient.auth.admin.createUser({
      email,
      email_confirm: true,
      password,
    });

    expect(error).toBeNull();
    expect(data.user).not.toBeNull();
    createdUserIds.add(data.user!.id);

    const browserClient = createBrowserClient();
    const signInResult = await browserClient.auth.signInWithPassword({ email, password });
    expect(signInResult.error).toBeNull();

    return { browserClient, user: data.user! };
  }

  it('registers with a magic link, creates a profile after verification, refreshes and signs out', async () => {
    const email = `magic-${crypto.randomUUID()}@${magicLinkTestDomain}`;
    const browserClient = createBrowserClient();
    const registration = await browserClient.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: 'http://localhost:8788/auth/callback',
        shouldCreateUser: true,
      },
    });

    expect(registration.error).toBeNull();

    const usersResult = await serviceClient.auth.admin.listUsers();
    expect(usersResult.error).toBeNull();
    const registeredUser = usersResult.data.users.find((user) => user.email === email);
    expect(registeredUser).toBeDefined();
    createdUserIds.add(registeredUser!.id);

    const generatedLink = await serviceClient.auth.admin.generateLink({
      email,
      type: 'magiclink',
    });
    expect(generatedLink.error).toBeNull();
    const tokenHash = generatedLink.data.properties?.hashed_token;
    expect(tokenHash).toBeTruthy();

    if (!tokenHash) {
      throw new Error('Supabase did not return a magic-link token hash.');
    }

    const verification = await browserClient.auth.verifyOtp({
      token_hash: tokenHash,
      type: 'magiclink',
    });
    expect(verification.error).toBeNull();
    expect(verification.data.session).not.toBeNull();

    const profileAfterVerification = await browserClient
      .from('profiles')
      .select('id, role, status')
      .single();
    expect(profileAfterVerification.error).toBeNull();
    expect(profileAfterVerification.data).toEqual({
      id: registeredUser!.id,
      role: 'member',
      status: 'active',
    });

    const refresh = await browserClient.auth.refreshSession({
      refresh_token: verification.data.session!.refresh_token,
    });
    expect(refresh.error).toBeNull();
    expect(refresh.data.session?.user.id).toBe(registeredUser!.id);

    expect((await browserClient.auth.signOut()).error).toBeNull();
    const sessionAfterSignOut = await browserClient.auth.getSession();
    expect(sessionAfterSignOut.error).toBeNull();
    expect(sessionAfterSignOut.data.session).toBeNull();
  });

  it('isolates user-owned rows and rejects browser writes to protected data', async () => {
    const first = await createVerifiedUser('rls-first');
    const second = await createVerifiedUser('rls-second');

    const ownProfile = await first.browserClient.from('profiles').select('id').single();
    expect(ownProfile.error).toBeNull();
    expect(ownProfile.data?.id).toBe(first.user.id);

    const otherProfile = await first.browserClient
      .from('profiles')
      .select('id')
      .eq('id', second.user.id);
    expect(otherProfile.error).toBeNull();
    expect(otherProfile.data).toEqual([]);

    const otherSubscription = await first.browserClient
      .from('subscriptions')
      .select('id')
      .eq('user_id', second.user.id);
    expect(otherSubscription.error).toBeNull();
    expect(otherSubscription.data).toEqual([]);

    const protectedSubscriptionColumns = await first.browserClient
      .from('subscriptions')
      .select(
        'stripe_customer_id,stripe_subscription_id,stripe_price_id,stripe_checkout_session_id,last_stripe_event_created_at',
      )
      .eq('user_id', first.user.id);
    expect(protectedSubscriptionColumns.error?.code).toBe('42501');

    const otherUsagePeriod = await first.browserClient
      .from('usage_periods')
      .select('id')
      .eq('user_id', second.user.id);
    expect(otherUsagePeriod.error).toBeNull();
    expect(otherUsagePeriod.data).toEqual([]);

    const ownDisplayNameWrite = await first.browserClient
      .from('profiles')
      .update({ display_name: 'Allowed display name' })
      .eq('id', first.user.id)
      .select('display_name')
      .single();
    expect(ownDisplayNameWrite.error).toBeNull();
    expect(ownDisplayNameWrite.data?.display_name).toBe('Allowed display name');

    const crossUserWrite = await first.browserClient
      .from('profiles')
      .update({ display_name: 'Unauthorized change' })
      .eq('id', second.user.id)
      .select('id');
    expect(crossUserWrite.error).toBeNull();
    expect(crossUserWrite.data).toEqual([]);

    const unchangedOtherProfile = await serviceClient
      .from('profiles')
      .select('display_name')
      .eq('id', second.user.id)
      .single();
    expect(unchangedOtherProfile.error).toBeNull();
    expect(unchangedOtherProfile.data?.display_name).toBeNull();

    const roleWrite = await first.browserClient
      .from('profiles')
      .update({ role: 'admin' })
      .eq('id', first.user.id);
    expect(roleWrite.error?.code).toBe('42501');

    const planWrite = await first.browserClient.from('plans').insert({
      code: 'browser-plan',
      display_name: 'Browser plan',
      monthly_character_limit: 1,
      request_character_limit: 1,
    });
    expect(planWrite.error?.code).toBe('42501');

    const subscriptionWrite = await first.browserClient
      .from('subscriptions')
      .update({ plan_code: 'pro' })
      .eq('user_id', first.user.id);
    expect(subscriptionWrite.error?.code).toBe('42501');

    const ledgerWrite = await first.browserClient.from('usage_ledger').insert({
      entry_type: 'reserve',
      input_characters: 1,
      period_id: crypto.randomUUID(),
      request_id: crypto.randomUUID(),
      user_id: first.user.id,
    });
    expect(ledgerWrite.error?.code).toBe('42501');

    const protectedLedgerColumns = await first.browserClient
      .from('usage_ledger')
      .select('input_tokens, output_tokens, cost_microusd')
      .eq('user_id', first.user.id);
    expect(protectedLedgerColumns.error?.code).toBe('42501');

    const browserReservation = await first.browserClient.rpc('reserve_quota', {
      p_input_characters: 1,
      p_request_id: crypto.randomUUID(),
      p_user_id: first.user.id,
    });
    expect(browserReservation.error?.code).toBe('42501');

    const serviceRoleDelete = await serviceClient.from('plans').delete().eq('code', 'free');
    expect(serviceRoleDelete.error?.code).toBe('42501');

    const serviceRoleRoleWrite = await serviceClient
      .from('profiles')
      .update({ role: 'admin' })
      .eq('id', first.user.id);
    expect(serviceRoleRoleWrite.error?.code).toBe('42501');
  });

  it('serializes concurrent reservations and settles or releases each request once', async () => {
    const quotaUser = await createVerifiedUser('quota');
    const requestIds = Array.from({ length: 4 }, () => crypto.randomUUID());

    const reservations = await Promise.all(
      requestIds.map((requestId) =>
        serviceClient.rpc('reserve_quota', {
          p_input_characters: 3_000,
          p_request_id: requestId,
          p_user_id: quotaUser.user.id,
        }),
      ),
    );

    const successfulReservations = reservations.filter((result) => result.error === null);
    const rejectedReservations = reservations.filter((result) => result.error !== null);
    expect(successfulReservations).toHaveLength(3);
    expect(rejectedReservations).toHaveLength(1);
    expect(rejectedReservations[0]?.error?.message).toContain('QUOTA_EXCEEDED');

    const successfulRequestIds = requestIds.filter((_, index) => !reservations[index]?.error);
    const release = (requestId: string) =>
      serviceClient.rpc('release_quota', {
        p_request_id: requestId,
        p_user_id: quotaUser.user.id,
      });

    for (const requestId of successfulRequestIds) {
      expect((await release(requestId)).error).toBeNull();
      expect((await release(requestId)).error).toBeNull();
    }

    const settledRequestId = crypto.randomUUID();
    const reserveForSettlement = await serviceClient.rpc('reserve_quota', {
      p_input_characters: 1_000,
      p_request_id: settledRequestId,
      p_user_id: quotaUser.user.id,
    });
    expect(reserveForSettlement.error).toBeNull();

    const settle = () =>
      serviceClient.rpc('settle_quota', {
        p_cost_microusd: 17,
        p_input_tokens: 250,
        p_output_tokens: 125,
        p_request_id: settledRequestId,
        p_user_id: quotaUser.user.id,
      });

    expect((await settle()).error).toBeNull();
    expect((await settle()).error).toBeNull();

    const usagePeriod = await serviceClient
      .from('usage_periods')
      .select('reserved_characters, consumed_characters')
      .eq('user_id', quotaUser.user.id)
      .single();
    expect(usagePeriod.error).toBeNull();
    expect(usagePeriod.data).toEqual({
      consumed_characters: 1_000,
      reserved_characters: 0,
    });

    const ledger = await serviceClient
      .from('usage_ledger')
      .select('entry_type')
      .eq('user_id', quotaUser.user.id);
    expect(ledger.error).toBeNull();
    expect(ledger.data?.filter((entry) => entry.entry_type === 'reserve')).toHaveLength(4);
    expect(ledger.data?.filter((entry) => entry.entry_type === 'release')).toHaveLength(3);
    expect(ledger.data?.filter((entry) => entry.entry_type === 'settle')).toHaveLength(1);
  });

  it('keeps a Pro billing period separate when its dates match the Free month', async () => {
    const proUser = await createVerifiedUser('pro-overlap');
    const freePeriod = await serviceClient
      .from('usage_periods')
      .select('period_start, period_end')
      .eq('user_id', proUser.user.id)
      .eq('plan_code', 'free')
      .single();
    expect(freePeriod.error).toBeNull();

    const subscriptionUpdate = await serviceClient.rpc('process_stripe_webhook_event', {
      p_cancel_at_period_end: false,
      p_checkout_session_id: null,
      p_customer_id: `cus_${crypto.randomUUID().replaceAll('-', '')}`,
      p_event_created_at: new Date().toISOString(),
      p_event_id: `evt_${crypto.randomUUID().replaceAll('-', '')}`,
      p_event_type: 'customer.subscription.updated',
      p_grace_period_end: null,
      p_payload_sha256: 'b'.repeat(64),
      p_period_end: freePeriod.data!.period_end,
      p_period_start: freePeriod.data!.period_start,
      p_price_id: 'price_test_pro_monthly',
      p_status: 'active',
      p_subscription_id: `sub_${crypto.randomUUID().replaceAll('-', '')}`,
      p_user_id: proUser.user.id,
    });
    expect(subscriptionUpdate.error).toBeNull();

    const requestId = crypto.randomUUID();
    const reservation = await serviceClient.rpc('reserve_quota', {
      p_input_characters: 15_000,
      p_request_id: requestId,
      p_user_id: proUser.user.id,
    });
    expect(reservation.error).toBeNull();

    const usagePeriods = await serviceClient
      .from('usage_periods')
      .select('plan_code, base_allowance')
      .eq('user_id', proUser.user.id)
      .order('base_allowance');
    expect(usagePeriods.error).toBeNull();
    expect(usagePeriods.data).toEqual([
      { base_allowance: 10_000, plan_code: 'free' },
      { base_allowance: 500_000, plan_code: 'pro' },
    ]);

    const release = await serviceClient.rpc('release_quota', {
      p_request_id: requestId,
      p_user_id: proUser.user.id,
    });
    expect(release.error).toBeNull();
  });

  it('bootstraps one verified administrator through an audited service operation', async () => {
    const administrator = await createVerifiedUser('administrator');
    const requestId = crypto.randomUUID();
    const bootstrap = () =>
      serviceClient.rpc('bootstrap_administrator', {
        p_reason: 'Phase 2 integration test',
        p_request_id: requestId,
        p_user_id: administrator.user.id,
      });

    const firstBootstrap = await bootstrap();
    expect(firstBootstrap.error).toBeNull();
    expect(firstBootstrap.data).toBe(true);

    const repeatedBootstrap = await bootstrap();
    expect(repeatedBootstrap.error).toBeNull();
    expect(repeatedBootstrap.data).toBe(false);

    const profile = await serviceClient
      .from('profiles')
      .select('role')
      .eq('id', administrator.user.id)
      .single();
    expect(profile.error).toBeNull();
    expect(profile.data?.role).toBe('admin');

    const auditEntries = await serviceClient
      .from('admin_audit_logs')
      .select('action, reason, target_user_id')
      .eq('request_id', requestId);
    expect(auditEntries.error).toBeNull();
    expect(auditEntries.data).toEqual([
      {
        action: 'administrator.bootstrap',
        reason: 'Phase 2 integration test',
        target_user_id: administrator.user.id,
      },
    ]);
  });

  it('permits only service role to anonymize a member before Auth soft deletion', async () => {
    const member = await createVerifiedUser('account-delete');
    const requestId = crypto.randomUUID();

    const browserAttempt = await member.browserClient.rpc('anonymize_deleted_member', {
      p_request_id: requestId,
      p_user_id: member.user.id,
    });
    expect(browserAttempt.error?.code).toBe('42501');

    const serviceAttempt = await serviceClient.rpc('anonymize_deleted_member', {
      p_request_id: requestId,
      p_user_id: member.user.id,
    });
    expect(serviceAttempt.error).toBeNull();

    const profile = await serviceClient
      .from('profiles')
      .select('display_name, role, status')
      .eq('id', member.user.id)
      .single();
    expect(profile.error).toBeNull();
    expect(profile.data).toEqual({
      display_name: null,
      role: 'member',
      status: 'suspended',
    });

    const auditEntry = await serviceClient
      .from('admin_audit_logs')
      .select('action, reason, target_user_id')
      .eq('request_id', requestId)
      .single();
    expect(auditEntry.error).toBeNull();
    expect(auditEntry.data).toEqual({
      action: 'account.delete',
      reason: 'self-service account deletion',
      target_user_id: member.user.id,
    });
  });
});
