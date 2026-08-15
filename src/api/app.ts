import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType } from 'zod';

interface ApiBindings {
  EBOND_API_KEY: string;
  EBOND_BASE_URL: string;
  EBOND_MODEL: string;
}

interface ApiVariables {
  requestId: string;
  requestStartedAt: number;
  validatedBody: unknown;
}

export interface ApiEnvironment {
  Bindings: ApiBindings;
  Variables: ApiVariables;
}

export const API_ERROR_CODE = {
  internalError: 'INTERNAL_ERROR',
  invalidJson: 'INVALID_JSON',
  notFound: 'NOT_FOUND',
  validationFailed: 'VALIDATION_FAILED',
} as const;

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

export function createApiApp() {
  const app = new Hono<ApiEnvironment>();

  app.use('*', requestIdMiddleware);
  app.get('/api/v1/health', (context) =>
    successResponse(context, 'The API is healthy.', {
      service: 'claude-watermark-api',
      status: 'ok',
    }),
  );
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
