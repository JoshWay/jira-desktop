import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  // Each test launches a real Electron app with visible windows; run them one at a time
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results'
})
