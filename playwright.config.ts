import { defineConfig } from '@playwright/test';
const mediaRoot =
  process.env.STUDIO_TEST_MEDIA_ROOT || '.artifacts/node-workbench-demo-sdd-' + Date.now();
process.env.STUDIO_TEST_MEDIA_ROOT = mediaRoot;
export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  outputDir: '.artifacts/workbench-browser/results',
  reporter: [
    ['list'],
    ['html', { outputFolder: '.artifacts/workbench-browser/report', open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4404',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    channel: 'msedge',
  },
  webServer: [
    {
      command: 'npx tsx scripts/node-workbench-demo.ts ' + mediaRoot,
      url: 'http://127.0.0.1:4403/api/health',
      env: { STUDIO_TEST_API_PORT: '4403' },
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'npx vite --host 127.0.0.1 --port 4404',
      url: 'http://127.0.0.1:4404',
      env: { STUDIO_API_ORIGIN: 'http://127.0.0.1:4403' },
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
});
