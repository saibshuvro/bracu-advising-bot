const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  workers: 1, // the tests share one mock server
  fullyParallel: false,
  reporter: [['list']],
  webServer: {
    command: 'node mock/server.js',
    url: 'http://localhost:8787/student/advising/self-registration',
    reuseExistingServer: false, // always test against the current mock code
    timeout: 20_000,
  },
  use: { trace: 'retain-on-failure' },
});
