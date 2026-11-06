import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4100', launchOptions: { executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' } },
  webServer: { command: 'node --import tsx src/hub/main.ts', url: 'http://127.0.0.1:4100/api/health', reuseExistingServer: true, timeout: 30000 },
});
