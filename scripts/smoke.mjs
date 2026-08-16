import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const port = 8799;
const baseUrl = `http://127.0.0.1:${port}`;
const wranglerExecutable = resolve(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
);
const server = spawn(
  wranglerExecutable,
  [
    'pages',
    'dev',
    'dist',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--binding',
    'SUPABASE_URL=https://project-ref.supabase.co',
    '--binding',
    'SUPABASE_PUBLISHABLE_KEY=sb_publishable_smoke-test-key-fixture',
  ],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serverOutput = '';

server.stdout.on('data', (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk.toString();
});

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForServer() {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Wrangler exited before startup.\n${serverOutput}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/v1/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Wrangler has not started listening yet.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }

  throw new Error(`Wrangler did not start within 20 seconds.\n${serverOutput}`);
}

async function verifyResponse(path, expectedText) {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.text();

  assert(response.status === 200, `${path} returned ${response.status}.`);
  assert(body.includes(expectedText), `${path} did not include the expected content.`);

  return body;
}

try {
  await waitForServer();
  const pageChecks = [
    ['/', "Claude's Invisible Text Watermark"],
    ['/what-is-claude-watermark', "What Is Claude's Invisible Text Watermark"],
    ['/how-it-works', "How Claude's Watermarking Works"],
    ['/changes-2026', 'What Changed in Claude Watermarking Recently'],
    ['/checker', 'Claude Watermark Self-Check'],
    ['/rewrite', 'AI Text Rewriter'],
    ['/login', 'Sign in to Watermark Lens'],
    ['/account', 'Your account'],
    ['/privacy', 'Privacy Policy'],
    ['/terms', 'Terms of Service'],
    ['/cookie', 'Cookie Policy'],
    ['/auth/callback', 'Completing sign-in'],
  ];

  for (const [path, expectedText] of pageChecks) {
    await verifyResponse(path, expectedText);
  }

  await verifyResponse('/js/auth.js', 'exchangeCodeForSession');
  await verifyResponse('/js/rewrite.js', 'idempotency-key');

  const healthResponse = await fetch(`${baseUrl}/api/v1/health`);
  const healthBody = await healthResponse.json();

  assert(healthResponse.status === 200, 'Health endpoint did not return 200.');
  assert(healthBody.success === true, 'Health endpoint did not report success.');
  assert(healthBody.message === 'The API is healthy.', 'Health message did not match.');
  assert(healthBody.data?.status === 'ok', 'Health status did not report ok.');
  assert(
    healthResponse.headers.get('x-request-id') === healthBody.requestId,
    'Health request ID header did not match the response body.',
  );

  const authConfigResponse = await fetch(`${baseUrl}/api/v1/auth/config`);
  const authConfigBody = await authConfigResponse.json();

  assert(authConfigResponse.status === 200, 'Auth config endpoint did not return 200.');
  assert(
    authConfigBody.data?.supabaseUrl === 'https://project-ref.supabase.co',
    'Auth config did not return the expected Supabase URL.',
  );
  assert(
    authConfigBody.data?.supabasePublishableKey === 'sb_publishable_smoke-test-key-fixture',
    'Auth config did not return the expected publishable key.',
  );
  assert(
    !JSON.stringify(authConfigBody).includes('SERVICE_ROLE'),
    'Auth config exposed a server-only key name.',
  );

  console.log('Pages smoke test passed (public pages, member auth routes, and API health).');
} finally {
  server.kill('SIGTERM');
  await Promise.race([
    once(server, 'exit'),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
  ]);
}
