import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:8788',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'npm run build && wrangler pages dev dist --ip 127.0.0.1 --port 8788 --binding SUPABASE_URL=https://project-ref.supabase.co --binding SUPABASE_PUBLISHABLE_KEY=sb_publishable_playwright-test-key-fixture',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    url: 'http://127.0.0.1:8788/api/v1/health',
  },
});
