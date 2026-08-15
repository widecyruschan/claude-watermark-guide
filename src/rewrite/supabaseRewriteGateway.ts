import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import type {
  BeginRewriteRequest,
  CompleteRewriteRequest,
  FailRewriteRequest,
  RewriteAuthenticator,
  RewriteRepository,
} from './rewriteService';
import { RewriteError, type RewriteErrorCode } from './rewriteService';

const beginResultSchema = z
  .array(
    z.object({
      claim_state: z.enum(['claimed', 'failed', 'processing', 'succeeded']),
      remaining_characters: z.number().int().nonnegative(),
    }),
  )
  .length(1);

const completionResultSchema = z
  .array(
    z.object({
      remaining_characters: z.number().int().nonnegative(),
    }),
  )
  .length(1);

const DATABASE_ERROR_CODES: ReadonlyArray<[string, RewriteErrorCode]> = [
  ['ACCOUNT_NOT_INITIALIZED', 'ACCOUNT_NOT_INITIALIZED'],
  ['ACCOUNT_SUSPENDED', 'ACCOUNT_SUSPENDED'],
  ['REQUEST_LIMIT_EXCEEDED', 'REQUEST_LIMIT_EXCEEDED'],
  ['QUOTA_EXCEEDED', 'QUOTA_EXCEEDED'],
  ['REQUEST_ID_CONFLICT', 'IDEMPOTENCY_CONFLICT'],
];

export class SupabaseRewriteGateway implements RewriteAuthenticator, RewriteRepository {
  private readonly client: SupabaseClient;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.client = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });
  }

  async authenticate(authorizationHeader: string | undefined): Promise<{ userId: string }> {
    const tokenMatch = /^Bearer ([^\s]+)$/u.exec(authorizationHeader ?? '');

    if (!tokenMatch?.[1]) {
      throw new RewriteError('AUTHENTICATION_REQUIRED');
    }

    const { data, error } = await this.client.auth.getUser(tokenMatch[1]);

    if (error || !data.user) {
      throw new RewriteError('AUTHENTICATION_REQUIRED');
    }

    return { userId: data.user.id };
  }

  async beginRewriteRequest(input: BeginRewriteRequest) {
    const { data, error } = await this.client.rpc('begin_rewrite_request', {
      p_input_characters: input.inputCharacters,
      p_input_sha256: input.inputSha256,
      p_model: input.model,
      p_prompt_version: input.promptVersion,
      p_provider: input.provider,
      p_request_id: input.requestId,
      p_user_id: input.userId,
    });

    if (error) {
      throw mapDatabaseError(error.message);
    }

    const parsedResult = beginResultSchema.safeParse(data);

    if (!parsedResult.success) {
      throw new RewriteError('DATABASE_UNAVAILABLE');
    }

    const result = parsedResult.data[0];

    if (!result) {
      throw new RewriteError('DATABASE_UNAVAILABLE');
    }

    return {
      claimState: result.claim_state,
      remainingCharacters: result.remaining_characters,
    };
  }

  async completeRewriteRequest(input: CompleteRewriteRequest) {
    const { data, error } = await this.client.rpc('complete_rewrite_request', {
      p_cost_microusd: input.costMicrousd,
      p_input_tokens: input.inputTokens,
      p_output_tokens: input.outputTokens,
      p_request_id: input.requestId,
      p_user_id: input.userId,
    });

    return parseCompletionResult(data, error?.message);
  }

  async failRewriteRequest(input: FailRewriteRequest) {
    const { data, error } = await this.client.rpc('fail_rewrite_request', {
      p_error_code: input.errorCode,
      p_request_id: input.requestId,
      p_user_id: input.userId,
    });

    return parseCompletionResult(data, error?.message);
  }
}

function parseCompletionResult(data: unknown, errorMessage: string | undefined) {
  if (errorMessage) {
    throw mapDatabaseError(errorMessage);
  }

  const parsedResult = completionResultSchema.safeParse(data);

  if (!parsedResult.success) {
    throw new RewriteError('DATABASE_UNAVAILABLE');
  }

  const result = parsedResult.data[0];

  if (!result) {
    throw new RewriteError('DATABASE_UNAVAILABLE');
  }

  return { remainingCharacters: result.remaining_characters };
}

function mapDatabaseError(message: string): RewriteError {
  const matchedError = DATABASE_ERROR_CODES.find(([databaseCode]) =>
    message.includes(databaseCode),
  );
  return new RewriteError(matchedError?.[1] ?? 'DATABASE_UNAVAILABLE');
}
