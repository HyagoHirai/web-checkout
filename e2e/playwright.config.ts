import { defineConfig, devices } from '@playwright/test';

const clientPort = process.env.CLIENT_PORT ?? '8080';
const baseURL = `http://localhost:${clientPort}`;

export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'kiosk',
      testDir: './tests',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1024, height: 768 },
        hasTouch: true,
        isMobile: false,
      },
    },
    {
      name: 'ops',
      testDir: './ops',
      timeout: 600_000,
    },
  ],
  webServer: process.env.PLAYWRIGHT_NO_SERVER
    ? undefined
    : {
        command: 'docker compose up --build',
        cwd: '..',
        url: `${baseURL}/api/health`,
        reuseExistingServer: true,
        timeout: 300_000,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
      },
});
