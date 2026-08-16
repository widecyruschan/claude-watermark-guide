import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const hasDatabaseEnvironment = Boolean(supabaseUrl && anonKey && serviceRoleKey);

function createClientWithoutSession(key: string): SupabaseClient {
  return createClient(supabaseUrl, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

describe.skipIf(!hasDatabaseEnvironment)('Phase 3 rewrite database behavior', () => {
  const createdUserIds = new Set<string>();
  let serviceClient: SupabaseClient;

  beforeAll(() => {
    serviceClient = createClientWithoutSession(serviceRoleKey);
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
    const createdUser = await serviceClient.auth.admin.createUser({
      email,
      email_confirm: true,
      password,
    });

    expect(createdUser.error).toBeNull();
    expect(createdUser.data.user).not.toBeNull();
    createdUserIds.add(createdUser.data.user!.id);

    const browserClient = createClientWithoutSession(anonKey);
    const signIn = await browserClient.auth.signInWithPassword({ email, password });
    expect(signIn.error).toBeNull();

    return { browserClient, user: createdUser.data.user! };
  }

  function beginRewrite(userId: string, requestId: string, inputSha256: string) {
    return serviceClient.rpc('begin_rewrite_request', {
      p_input_characters: 1_000,
      p_input_sha256: inputSha256,
      p_model: 'gpt-5.5',
      p_prompt_version: 'rewrite-v1.1.0',
      p_provider: 'ebond',
      p_request_id: requestId,
      p_user_id: userId,
    });
  }

  it('grants one execution claim for concurrent duplicate idempotency keys', async () => {
    const member = await createVerifiedUser('rewrite-claim');
    const requestId = crypto.randomUUID();
    const inputSha256 = 'a'.repeat(64);

    const [first, second] = await Promise.all([
      beginRewrite(member.user.id, requestId, inputSha256),
      beginRewrite(member.user.id, requestId, inputSha256),
    ]);

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect([first.data?.[0]?.claim_state, second.data?.[0]?.claim_state].sort()).toEqual([
      'claimed',
      'processing',
    ]);

    const conflict = await beginRewrite(member.user.id, requestId, 'b'.repeat(64));
    expect(conflict.error?.message).toContain('REQUEST_ID_CONFLICT');

    const failed = await serviceClient.rpc('fail_rewrite_request', {
      p_error_code: 'PROVIDER_UNAVAILABLE',
      p_request_id: requestId,
      p_user_id: member.user.id,
    });
    expect(failed.error).toBeNull();
    expect(failed.data?.[0]?.request_state).toBe('failed');

    const repeatedFailure = await serviceClient.rpc('fail_rewrite_request', {
      p_error_code: 'PROVIDER_UNAVAILABLE',
      p_request_id: requestId,
      p_user_id: member.user.id,
    });
    expect(repeatedFailure.error).toBeNull();
    expect(repeatedFailure.data?.[0]?.request_state).toBe('failed');

    const duplicateAfterFailure = await beginRewrite(member.user.id, requestId, inputSha256);
    expect(duplicateAfterFailure.error).toBeNull();
    expect(duplicateAfterFailure.data?.[0]?.claim_state).toBe('failed');

    const period = await serviceClient
      .from('usage_periods')
      .select('reserved_characters, consumed_characters')
      .eq('user_id', member.user.id)
      .eq('plan_code', 'free')
      .single();
    expect(period.error).toBeNull();
    expect(period.data).toEqual({ consumed_characters: 0, reserved_characters: 0 });
  });

  it('settles usage once and exposes no rewrite content to database clients', async () => {
    const member = await createVerifiedUser('rewrite-settle');
    const requestId = crypto.randomUUID();
    const inputSha256 = 'c'.repeat(64);
    const begin = await beginRewrite(member.user.id, requestId, inputSha256);
    expect(begin.error).toBeNull();
    expect(begin.data?.[0]?.claim_state).toBe('claimed');

    const complete = () =>
      serviceClient.rpc('complete_rewrite_request', {
        p_cost_microusd: 600,
        p_input_tokens: 250,
        p_output_tokens: 125,
        p_request_id: requestId,
        p_user_id: member.user.id,
      });

    const firstCompletion = await complete();
    expect(firstCompletion.error).toBeNull();
    expect(firstCompletion.data?.[0]).toMatchObject({
      remaining_characters: 9_000,
      request_state: 'succeeded',
    });

    const repeatedCompletion = await complete();
    expect(repeatedCompletion.error).toBeNull();
    expect(repeatedCompletion.data?.[0]?.request_state).toBe('succeeded');

    const duplicateAfterCompletion = await beginRewrite(member.user.id, requestId, inputSha256);
    expect(duplicateAfterCompletion.error).toBeNull();
    expect(duplicateAfterCompletion.data?.[0]?.claim_state).toBe('succeeded');

    const requestRow = await serviceClient
      .from('rewrite_requests')
      .select('*')
      .eq('user_id', member.user.id)
      .eq('request_id', requestId)
      .single();
    expect(requestRow.error).toBeNull();
    expect(requestRow.data).toMatchObject({
      cost_microusd: 600,
      input_characters: 1_000,
      input_sha256: inputSha256,
      input_tokens: 250,
      output_tokens: 125,
      status: 'succeeded',
    });
    expect(requestRow.data).not.toHaveProperty('request_text');
    expect(requestRow.data).not.toHaveProperty('response_text');
    expect(requestRow.data).not.toHaveProperty('authorization');
    expect(requestRow.data).not.toHaveProperty('api_key');

    const ledger = await serviceClient
      .from('usage_ledger')
      .select('entry_type, input_tokens, output_tokens, cost_microusd')
      .eq('user_id', member.user.id)
      .eq('request_id', requestId)
      .eq('entry_type', 'settle')
      .single();
    expect(ledger.error).toBeNull();
    expect(ledger.data).toEqual({
      cost_microusd: 600,
      entry_type: 'settle',
      input_tokens: 250,
      output_tokens: 125,
    });

    const browserRead = await member.browserClient.from('rewrite_requests').select('*');
    expect(browserRead.error?.code).toBe('42501');

    const browserComplete = await member.browserClient.rpc('complete_rewrite_request', {
      p_cost_microusd: 600,
      p_input_tokens: 250,
      p_output_tokens: 125,
      p_request_id: requestId,
      p_user_id: member.user.id,
    });
    expect(browserComplete.error?.code).toBe('42501');

    const serviceRoleUpdate = await serviceClient
      .from('rewrite_requests')
      .update({ prompt_version: 'unauthorized-direct-write' })
      .eq('user_id', member.user.id)
      .eq('request_id', requestId);
    expect(serviceRoleUpdate.error?.code).toBe('42501');

    const serviceRoleDelete = await serviceClient
      .from('rewrite_requests')
      .delete()
      .eq('user_id', member.user.id)
      .eq('request_id', requestId);
    expect(serviceRoleDelete.error?.code).toBe('42501');
  });
});
