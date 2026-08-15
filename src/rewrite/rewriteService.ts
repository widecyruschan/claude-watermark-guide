import { calculateEbondAiCostMicrousd } from './cost';
import type { RewriteProviderResult } from './contracts';
import { EbondProviderError, type EbondProviderErrorCode } from './ebondProvider';
import { REWRITE_PROMPT_VERSION } from './prompt';

export type RewriteErrorCode =
  | 'ACCOUNT_NOT_INITIALIZED'
  | 'ACCOUNT_SUSPENDED'
  | 'AUTHENTICATION_REQUIRED'
  | 'DATABASE_UNAVAILABLE'
  | 'IDEMPOTENCY_ALREADY_COMPLETED'
  | 'IDEMPOTENCY_ALREADY_FAILED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'QUOTA_EXCEEDED'
  | 'REQUEST_LIMIT_EXCEEDED';

export class RewriteError extends Error {
  constructor(readonly code: RewriteErrorCode) {
    super(code);
    this.name = 'RewriteError';
  }
}

export interface RewriteAuthenticator {
  authenticate(authorizationHeader: string | undefined): Promise<{ userId: string }>;
}

export interface BeginRewriteRequest {
  inputCharacters: number;
  inputSha256: string;
  model: string;
  promptVersion: string;
  provider: 'ebond';
  requestId: string;
  userId: string;
}

export interface CompleteRewriteRequest {
  costMicrousd: number;
  inputTokens: number;
  outputTokens: number;
  requestId: string;
  userId: string;
}

export interface FailRewriteRequest {
  errorCode: EbondProviderErrorCode;
  requestId: string;
  userId: string;
}

export interface RewriteRepository {
  beginRewriteRequest(input: BeginRewriteRequest): Promise<{
    claimState: 'claimed' | 'failed' | 'processing' | 'succeeded';
    remainingCharacters: number;
  }>;
  completeRewriteRequest(input: CompleteRewriteRequest): Promise<{
    remainingCharacters: number;
  }>;
  failRewriteRequest(input: FailRewriteRequest): Promise<{
    remainingCharacters: number;
  }>;
}

export interface RewriteProvider {
  rewrite(text: string, cancellationSignal?: AbortSignal): Promise<RewriteProviderResult>;
}

export interface RewriteRuntime {
  authenticator: RewriteAuthenticator;
  provider: RewriteProvider;
  repository: RewriteRepository;
}

interface ExecuteRewriteInput {
  cancellationSignal?: AbortSignal;
  model: string;
  requestId: string;
  text: string;
  userId: string;
}

export interface ExecuteRewriteResult {
  chargedCharacters: number;
  remainingCharacters: number;
  text: string;
}

export async function executeRewrite(
  runtime: RewriteRuntime,
  input: ExecuteRewriteInput,
): Promise<ExecuteRewriteResult> {
  const startedAt = Date.now();
  const inputCharacters = [...input.text].length;
  const inputSha256 = await createSha256(input.text);
  const claim = await runtime.repository.beginRewriteRequest({
    inputCharacters,
    inputSha256,
    model: input.model,
    promptVersion: REWRITE_PROMPT_VERSION,
    provider: 'ebond',
    requestId: input.requestId,
    userId: input.userId,
  });

  if (claim.claimState !== 'claimed') {
    const duplicateErrorCodes = {
      failed: 'IDEMPOTENCY_ALREADY_FAILED',
      processing: 'IDEMPOTENCY_IN_PROGRESS',
      succeeded: 'IDEMPOTENCY_ALREADY_COMPLETED',
    } as const;

    throw new RewriteError(duplicateErrorCodes[claim.claimState]);
  }

  let providerResult: RewriteProviderResult;

  try {
    providerResult = await runtime.provider.rewrite(input.text, input.cancellationSignal);
  } catch (error) {
    const providerError =
      error instanceof EbondProviderError ? error : new EbondProviderError('PROVIDER_UNAVAILABLE');

    try {
      await runtime.repository.failRewriteRequest({
        errorCode: providerError.code,
        requestId: input.requestId,
        userId: input.userId,
      });
    } catch (releaseError) {
      logRewriteEvent('error', {
        durationMs: Math.max(0, Date.now() - startedAt),
        errorCode:
          releaseError instanceof RewriteError ? releaseError.code : 'DATABASE_UNAVAILABLE',
        event: 'rewrite_quota_release_failed',
        requestId: input.requestId,
        userId: input.userId,
      });
      throw releaseError;
    }

    logRewriteEvent('error', {
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode: providerError.code,
      event: 'rewrite_provider_failed',
      providerStatusCode: providerError.statusCode,
      providerTransportFailure: providerError.transportFailureKind,
      requestId: input.requestId,
      userId: input.userId,
    });
    throw providerError;
  }

  const costMicrousd = calculateEbondAiCostMicrousd(
    providerResult.inputTokens,
    providerResult.outputTokens,
  );
  let settlement: { remainingCharacters: number };

  try {
    settlement = await completeRewriteWithRetry(runtime.repository, {
      costMicrousd,
      inputTokens: providerResult.inputTokens,
      outputTokens: providerResult.outputTokens,
      requestId: input.requestId,
      userId: input.userId,
    });
  } catch (settlementError) {
    logRewriteEvent('error', {
      costMicrousd,
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode:
        settlementError instanceof RewriteError ? settlementError.code : 'DATABASE_UNAVAILABLE',
      event: 'rewrite_quota_settlement_failed',
      inputCharacters,
      inputTokens: providerResult.inputTokens,
      outputTokens: providerResult.outputTokens,
      requestId: input.requestId,
      userId: input.userId,
    });
    throw settlementError;
  }

  logRewriteEvent('info', {
    costMicrousd,
    durationMs: Math.max(0, Date.now() - startedAt),
    event: 'rewrite_completed',
    inputCharacters,
    inputTokens: providerResult.inputTokens,
    model: input.model,
    outputTokens: providerResult.outputTokens,
    promptVersion: REWRITE_PROMPT_VERSION,
    requestId: input.requestId,
    userId: input.userId,
  });

  return {
    chargedCharacters: inputCharacters,
    remainingCharacters: settlement.remainingCharacters,
    text: providerResult.text,
  };
}

async function completeRewriteWithRetry(
  repository: RewriteRepository,
  input: CompleteRewriteRequest,
): Promise<{ remainingCharacters: number }> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await repository.completeRewriteRequest(input);
    } catch (error) {
      lastError = error;

      if (!(error instanceof RewriteError) || error.code !== 'DATABASE_UNAVAILABLE') {
        throw error;
      }
    }
  }

  throw lastError;
}

async function createSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface RewriteLogFields {
  costMicrousd?: number;
  durationMs: number;
  errorCode?: EbondProviderErrorCode | RewriteErrorCode;
  event:
    | 'rewrite_completed'
    | 'rewrite_provider_failed'
    | 'rewrite_quota_release_failed'
    | 'rewrite_quota_settlement_failed';
  inputCharacters?: number;
  inputTokens?: number;
  model?: string;
  outputTokens?: number;
  promptVersion?: string;
  providerStatusCode?: number;
  providerTransportFailure?: 'invalid_header' | 'network' | 'other';
  requestId: string;
  userId: string;
}

function logRewriteEvent(level: 'error' | 'info', fields: RewriteLogFields): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    ...fields,
  });

  if (level === 'error') {
    console.error(entry);
    return;
  }

  console.info(entry);
}
