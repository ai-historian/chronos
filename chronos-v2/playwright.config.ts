import { defineConfig } from "@playwright/test";

// End-to-end tests drive the built Electron app (out/main.js) through Playwright's
// `_electron` API, so no browser downloads are needed. Run `npm run build` first.
export default defineConfig({
  testDir: "test/e2e",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
});
