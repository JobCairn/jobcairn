import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test-visual",
  snapshotPathTemplate: "{testDir}/../../../docs/assets/brand-snapshots/{arg}-{platform}{ext}",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:4179", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  webServer: { command: "npx vite preview --config guide/vite.config.ts", url: "http://127.0.0.1:4179", reuseExistingServer: false },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled" } },
});
