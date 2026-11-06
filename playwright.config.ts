import { defineConfig } from '@playwright/test';

// BASE_URL runs the suite against a deployed copy instead of starting a local hub.
const remote = process.env.BASE_URL;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60000,
  workers: 1,
  use: { baseURL: remote ?? 'http://127.0.0.1:4100', launchOptions: { executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' } },
  webServer: remote ? undefined : { command: 'node --import tsx src/hub/main.ts', url: 'http://127.0.0.1:4100/api/health', reuseExistingServer: true, timeout: 30000 },
});
