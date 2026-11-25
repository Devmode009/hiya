import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, reporter: 'list', timeout: 45000,
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: process.platform === 'win32' ? { executablePath: process.env.HAYA_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : { channel: 'chrome' } },
  projects: [{ name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }, { name: 'tablet', use: { viewport: { width: 768, height: 1024 }, hasTouch: true } }, { name: 'laptop', use: { viewport: { width: 1440, height: 1000 } } }],
  webServer: { command: 'npm run dev -- --port 5173', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 30000 },
});
