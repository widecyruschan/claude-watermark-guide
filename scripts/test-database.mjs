import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const supabaseBinary = resolve(projectRoot, 'node_modules/.bin/supabase');
const vitestEntry = resolve(projectRoot, 'node_modules/vitest/vitest.mjs');

function readLocalSupabaseEnvironment() {
  let statusOutput;

  try {
    statusOutput = execFileSync(supabaseBinary, ['status', '--output', 'env'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('Local Supabase is not running. Run `npx supabase start` first.');
  }

  const values = new Map();

  for (const line of statusOutput.split('\n')) {
    const match = /^([A-Z_]+)="(.*)"$/u.exec(line.trim());

    if (match) {
      values.set(match[1], match[2]);
    }
  }

  const supabaseUrl = values.get('API_URL');
  const anonKey = values.get('ANON_KEY');
  const serviceRoleKey = values.get('SERVICE_ROLE_KEY');

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    throw new Error('Supabase status did not return the required local API credentials.');
  }

  return {
    SUPABASE_URL: supabaseUrl,
    SUPABASE_ANON_KEY: anonKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  };
}

const databaseEnvironment = readLocalSupabaseEnvironment();
const result = spawnSync(process.execPath, [vitestEntry, 'run', 'tests/database'], {
  cwd: projectRoot,
  env: { ...process.env, ...databaseEnvironment },
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
