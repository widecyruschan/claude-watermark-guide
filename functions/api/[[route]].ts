import { handle } from 'hono/cloudflare-pages';

import { createApiApp } from '../../src/api/app';

export const onRequest = handle(createApiApp());
