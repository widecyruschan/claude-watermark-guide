import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z, type ZodType } from 'zod';

import {
  REWRITE_MAX_BODY_BYTES,
  rewriteInputSchema,
  type RewriteInput,
} from '../rewrite/contracts';
import { EbondProvider, EbondProviderError } from '../rewrite/ebondProvider';
import {
  AccountDeletionError,
  executeRewrite,
  RewriteError,
  type RewriteRuntime,
} from '../rewrite/rewriteService';
import {
  SupabaseRewriteGateway,
  type AccountDeletionGateway,
} from '../rewrite/supabaseRewriteGateway';

export interface ApiBindings {
  EBOND_API_KEY: string;
  EBOND_API_MODE?: string;
  EBOND_BASE_URL: string;
  EBOND_MODEL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_URL: string;
}

interface ApiVariables {
  authenticatedUserId: string;
  requestId: string;
  requestStartedAt: number;
  rewriteRuntime: RewriteRuntime;
  validatedBody: unknown;
}

export interface ApiEnvironment {
  Bindings: ApiBindings;
  Variables: ApiVariables;
}

export const API_ERROR_CODE = {
  accountNotInitialized: 'ACCOUNT_NOT_INITIALIZED',
  accountDeleteUnavailable: 'ACCOUNT_DELETE_UNAVAILABLE',
  accountSuspended: 'ACCOUNT_SUSPENDED',
  authConfigurationError: 'AUTH_CONFIGURATION_ERROR',
  authenticationRequired: 'AUTHENTICATION_REQUIRED',
  databaseUnavailable: 'DATABASE_UNAVAILABLE',
  idempotencyAlreadyCompleted: 'IDEMPOTENCY_ALREADY_COMPLETED',
  idempotencyAlreadyFailed: 'IDEMPOTENCY_ALREADY_FAILED',
  idempotencyConflict: 'IDEMPOTENCY_CONFLICT',
  idempotencyInProgress: 'IDEMPOTENCY_IN_PROGRESS',
  internalError: 'INTERNAL_ERROR',
  invalidJson: 'INVALID_JSON',
  notFound: 'NOT_FOUND',
  payloadTooLarge: 'PAYLOAD_TOO_LARGE',
  providerCancelled: 'PROVIDER_CANCELLED',
  providerConfigurationError: 'PROVIDER_CONFIGURATION_ERROR',
  providerInvalidResponse: 'PROVIDER_INVALID_RESPONSE',
  providerRateLimited: 'PROVIDER_RATE_LIMITED',
  providerRejected: 'PROVIDER_REJECTED',
  providerTimeout: 'PROVIDER_TIMEOUT',
  providerUnavailable: 'PROVIDER_UNAVAILABLE',
  quotaExceeded: 'QUOTA_EXCEEDED',
  recentAuthenticationRequired: 'RECENT_AUTHENTICATION_REQUIRED',
  requestLimitExceeded: 'REQUEST_LIMIT_EXCEEDED',
  validationFailed: 'VALIDATION_FAILED',
} as const;

const publicAuthConfigSchema = z.object({
  supabasePublishableKey: z.string().startsWith('sb_publishable_').min(30),
  supabaseUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.supabase.co');
  }),
});

export type ApiErrorCode = (typeof API_ERROR_CODE)[keyof typeof API_ERROR_CODE];

export interface ApiSuccessResponse<T> {
  success: true;
  message: string;
  data: T;
  requestId: string;
}

export interface ApiErrorResponse {
  success: false;
  message: string;
  error: {
    code: ApiErrorCode;
    details: string;
  };
  requestId: string;
}

const requestIdMiddleware = createMiddleware<ApiEnvironment>(async (context, next) => {
  const requestId = crypto.randomUUID();

  context.set('requestId', requestId);
  context.set('requestStartedAt', Date.now());
  await next();
  context.header('x-request-id', requestId);
});

class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
    readonly details: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function successResponse<T>(
  context: Context<ApiEnvironment>,
  message: string,
  data: T,
  status: ContentfulStatusCode = 200,
) {
  const responseBody: ApiSuccessResponse<T> = {
    success: true,
    message,
    data,
    requestId: context.get('requestId'),
  };

  return context.json(responseBody, status);
}

function errorResponse(context: Context<ApiEnvironment>, error: ApiError) {
  const requestId = context.get('requestId');
  const responseBody: ApiErrorResponse = {
    success: false,
    message: error.message,
    error: {
      code: error.code,
      details: error.details,
    },
    requestId,
  };

  context.header('x-request-id', requestId);
  return context.json(responseBody, error.status);
}

function logUnhandledError(error: Error, context: Context<ApiEnvironment>) {
  const requestStartedAt = context.get('requestStartedAt');

  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'unhandled_api_error',
      requestId: context.get('requestId'),
      method: context.req.method,
      path: context.req.path,
      userId: null,
      ip: context.req.header('cf-connecting-ip') ?? null,
      statusCode: 500,
      errorCode: API_ERROR_CODE.internalError,
      errorMessage: 'An unexpected error occurred.',
      errorName: error.name,
      durationMs: Math.max(0, Date.now() - requestStartedAt),
    }),
  );
}

export function validateJsonBody(schema: ZodType) {
  return createMiddleware<ApiEnvironment>(async (context, next) => {
    let body: unknown;

    try {
      body = await context.req.json();
    } catch {
      throw new ApiError(
        400,
        API_ERROR_CODE.invalidJson,
        'The request body is invalid.',
        'Provide a valid JSON document and try again.',
      );
    }

    const validationResult = schema.safeParse(body);

    if (!validationResult.success) {
      throw new ApiError(
        422,
        API_ERROR_CODE.validationFailed,
        'The request payload is invalid.',
        'Check the submitted fields and try again.',
      );
    }

    context.set('validatedBody', validationResult.data);
    await next();
  });
}

interface CreateApiAppOptions {
  accountDeletionGatewayFactory?: (bindings: ApiBindings) => AccountDeletionGateway;
  rewriteRuntimeFactory?: (bindings: ApiBindings) => RewriteRuntime;
}

export function createApiApp(options: CreateApiAppOptions = {}) {
  const app = new Hono<ApiEnvironment>();
  const accountDeletionGatewayFactory =
    options.accountDeletionGatewayFactory ?? createProductionAccountDeletionGateway;
  const rewriteRuntimeFactory = options.rewriteRuntimeFactory ?? createProductionRewriteRuntime;

  app.use('*', requestIdMiddleware);
  app.get('/api/v1/health', (context) =>
    successResponse(context, 'The API is healthy.', {
      service: 'claude-watermark-api',
      status: 'ok',
    }),
  );
  app.get('/api/v1/auth/config', (context) => {
    const config = publicAuthConfigSchema.safeParse({
      supabasePublishableKey: context.env.SUPABASE_PUBLISHABLE_KEY,
      supabaseUrl: context.env.SUPABASE_URL,
    });

    if (!config.success) {
      throw new ApiError(
        503,
        API_ERROR_CODE.authConfigurationError,
        'Authentication is temporarily unavailable.',
        'Contact support before retrying sign-in.',
      );
    }

    context.header('cache-control', 'public, max-age=300');
    return successResponse(context, 'The authentication configuration is available.', config.data);
  });
  app.post(
    '/api/v1/rewrite',
    bodyLimit({
      maxSize: REWRITE_MAX_BODY_BYTES,
      onError: () => {
        throw new ApiError(
          413,
          API_ERROR_CODE.payloadTooLarge,
          'The request body is too large.',
          'Reduce the submitted text and try again.',
        );
      },
    }),
    createMiddleware<ApiEnvironment>(async (context, next) => {
      const rewriteRuntime = rewriteRuntimeFactory(context.env);
      const authenticatedUser = await rewriteRuntime.authenticator.authenticate(
        context.req.header('authorization'),
      );

      context.set('authenticatedUserId', authenticatedUser.userId);
      context.set('rewriteRuntime', rewriteRuntime);
      await next();
    }),
    validateJsonBody(rewriteInputSchema),
    async (context) => {
      const idempotencyKey = z.uuid().safeParse(context.req.header('idempotency-key'));

      if (!idempotencyKey.success) {
        throw new ApiError(
          422,
          API_ERROR_CODE.validationFailed,
          'The request payload is invalid.',
          'Provide a UUID in the Idempotency-Key header.',
        );
      }

      const body = context.get('validatedBody') as RewriteInput;
      const result = await executeRewrite(context.get('rewriteRuntime'), {
        cancellationSignal: context.req.raw.signal,
        model: context.env.EBOND_MODEL,
        options: body.options,
        requestId: idempotencyKey.data,
        text: body.text,
        userId: context.get('authenticatedUserId'),
      });

      return successResponse(context, 'The text was rewritten.', {
        text: result.text,
        usage: {
          chargedCharacters: result.chargedCharacters,
          remainingCharacters: result.remainingCharacters,
        },
      });
    },
  );
  app.post('/api/v1/account/delete', async (context) => {
    await accountDeletionGatewayFactory(context.env).deleteRecentlyAuthenticatedUser(
      context.req.header('authorization'),
      context.get('requestId'),
    );

    return successResponse(context, 'The account was deleted.', null);
  });
  app.notFound((context) =>
    errorResponse(
      context,
      new ApiError(
        404,
        API_ERROR_CODE.notFound,
        'The requested resource was not found.',
        'No API route matches this request.',
      ),
    ),
  );
  app.onError((error, context) => {
    if (error instanceof ApiError) {
      return errorResponse(context, error);
    }

    if (
      error instanceof RewriteError ||
      error instanceof EbondProviderError ||
      error instanceof AccountDeletionError
    ) {
      return errorResponse(context, mapRewriteError(error));
    }

    logUnhandledError(error, context);
    return errorResponse(
      context,
      new ApiError(
        500,
        API_ERROR_CODE.internalError,
        'The service could not complete the request.',
        'An unexpected error occurred.',
      ),
    );
  });

  return app;
}

function createProductionRewriteRuntime(bindings: ApiBindings): RewriteRuntime {
  const supabaseGateway = new SupabaseRewriteGateway(
    bindings.SUPABASE_URL,
    bindings.SUPABASE_SERVICE_ROLE_KEY,
  );

  return {
    authenticator: supabaseGateway,
    provider: new EbondProvider({
      apiKey: bindings.EBOND_API_KEY,
      apiMode: bindings.EBOND_API_MODE === 'chat_completions' ? 'chat_completions' : 'responses',
      baseUrl: bindings.EBOND_BASE_URL,
      enableConnectivityProbe: true,
      model: bindings.EBOND_MODEL,
    }),
    repository: supabaseGateway,
  };
}

function createProductionAccountDeletionGateway(bindings: ApiBindings): AccountDeletionGateway {
  return new SupabaseRewriteGateway(bindings.SUPABASE_URL, bindings.SUPABASE_SERVICE_ROLE_KEY);
}

function mapRewriteError(
  error: RewriteError | EbondProviderError | AccountDeletionError,
): ApiError {
  const errorDefinitions: Record<
    RewriteError['code'] | EbondProviderError['code'] | AccountDeletionError['code'],
    {
      details: string;
      message: string;
      status: ContentfulStatusCode;
    }
  > = {
    ACCOUNT_NOT_INITIALIZED: {
      details: 'Sign in again before retrying the request.',
      message: 'The member account is not ready.',
      status: 409,
    },
    ACCOUNT_DELETE_UNAVAILABLE: {
      details: 'Try again later or contact support if the problem continues.',
      message: 'The account could not be deleted right now.',
      status: 503,
    },
    ACCOUNT_SUSPENDED: {
      details: 'Contact support if you believe this is an error.',
      message: 'The member account is suspended.',
      status: 403,
    },
    AUTHENTICATION_REQUIRED: {
      details: 'Sign in and submit the request again.',
      message: 'Authentication is required.',
      status: 401,
    },
    DATABASE_UNAVAILABLE: {
      details: 'Try again later with a new request.',
      message: 'The service is temporarily unavailable.',
      status: 503,
    },
    IDEMPOTENCY_ALREADY_COMPLETED: {
      details: 'Use a new Idempotency-Key for a new rewrite.',
      message: 'This request was already completed.',
      status: 409,
    },
    IDEMPOTENCY_ALREADY_FAILED: {
      details: 'Use a new Idempotency-Key to retry the rewrite.',
      message: 'This request already failed.',
      status: 409,
    },
    IDEMPOTENCY_CONFLICT: {
      details: 'Do not reuse an Idempotency-Key with different input.',
      message: 'The idempotency key conflicts with an earlier request.',
      status: 409,
    },
    IDEMPOTENCY_IN_PROGRESS: {
      details: 'Wait for the original request to finish.',
      message: 'This request is already being processed.',
      status: 409,
    },
    PROVIDER_CANCELLED: {
      details: 'Submit a new request if a rewrite is still needed.',
      message: 'The rewrite request was cancelled.',
      status: 408,
    },
    PROVIDER_CONFIGURATION_ERROR: {
      details: 'Contact support before retrying the request.',
      message: 'The rewrite provider is not configured correctly.',
      status: 503,
    },
    PROVIDER_INVALID_RESPONSE: {
      details: 'Try again later with a new request.',
      message: 'The rewrite provider returned an invalid response.',
      status: 502,
    },
    PROVIDER_RATE_LIMITED: {
      details: 'Try again later with a new request.',
      message: 'The rewrite provider is temporarily busy.',
      status: 503,
    },
    PROVIDER_REJECTED: {
      details: 'Try again later with a new request.',
      message: 'The rewrite provider rejected the request.',
      status: 502,
    },
    PROVIDER_TIMEOUT: {
      details: 'Try again later with a new request.',
      message: 'The rewrite provider timed out.',
      status: 504,
    },
    PROVIDER_UNAVAILABLE: {
      details: 'Try again later with a new request.',
      message: 'The rewrite provider is unavailable.',
      status: 503,
    },
    QUOTA_EXCEEDED: {
      details: 'Wait for the next usage period or change plans.',
      message: 'The account quota has been reached.',
      status: 429,
    },
    RECENT_AUTHENTICATION_REQUIRED: {
      details: 'Sign in again, then return here to confirm account deletion.',
      message: 'Recent sign-in is required to delete this account.',
      status: 409,
    },
    REQUEST_LIMIT_EXCEEDED: {
      details: 'Reduce the submitted text and try again.',
      message: 'The text exceeds the plan request limit.',
      status: 422,
    },
  };
  const definition = errorDefinitions[error.code];

  return new ApiError(definition.status, error.code, definition.message, definition.details);
}
