import { defineConfig } from '@playwright/test';
import config from './playwright.config';

export default defineConfig({
  ...config,
  testIgnore: [],
  testMatch: '**/production.spec.ts',
  webServer: {
    ...config.webServer,
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    env: { NODE_ENV: 'production' },
  },
});
