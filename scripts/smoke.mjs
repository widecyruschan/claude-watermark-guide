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
  ['pages', 'dev', 'dist', '--ip', '127.0.0.1', '--port', String(port)],
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
  await verifyResponse('/', "Claude's Invisible Text Watermark");
  await verifyResponse('/checker', 'Claude Watermark Self-Check');

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

  console.log('Pages smoke test passed (home, checker, and API health).');
} finally {
  server.kill('SIGTERM');
  await Promise.race([
    once(server, 'exit'),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
  ]);
}
