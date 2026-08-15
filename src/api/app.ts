import { Hono } from 'hono';
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
  validatedBody: unknown;
}

export interface ApiEnvironment {
  Bindings: ApiBindings;
  Variables: ApiVariables;
}

const requestIdMiddleware = createMiddleware<ApiEnvironment>(async (context, next) => {
  const requestId = crypto.randomUUID();

  context.set('requestId', requestId);
  await next();
  context.header('x-request-id', requestId);
});

class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function validateJsonBody(schema: ZodType) {
  return createMiddleware<ApiEnvironment>(async (context, next) => {
    let body: unknown;

    try {
      body = await context.req.json();
    } catch {
      throw new ApiError(400, 'INVALID_JSON', 'The request body must contain valid JSON.');
    }

    const validationResult = schema.safeParse(body);

    if (!validationResult.success) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'The request payload is invalid.');
    }

    context.set('validatedBody', validationResult.data);
    await next();
  });
}

export function createApiApp() {
  const app = new Hono<ApiEnvironment>();

  app.use('*', requestIdMiddleware);
  app.get('/api/v1/health', (context) =>
    context.json({
      success: true,
      data: {
        service: 'claude-watermark-api',
        status: 'ok',
      },
      requestId: context.get('requestId'),
    }),
  );
  app.notFound((context) =>
    context.json(
      {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'The requested resource was not found.',
        },
        requestId: context.get('requestId'),
      },
      404,
    ),
  );
  app.onError((error, context) => {
    const requestId = context.get('requestId');
    const apiError =
      error instanceof ApiError
        ? error
        : new ApiError(500, 'INTERNAL_ERROR', 'The service could not complete the request.');

    context.header('x-request-id', requestId);
    return context.json(
      {
        success: false,
        error: {
          code: apiError.code,
          message: apiError.message,
        },
        requestId,
      },
      apiError.status,
    );
  });

  return app;
}
