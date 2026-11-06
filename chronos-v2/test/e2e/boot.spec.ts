// End-to-end boot test: launches the built app (out/main.js) against a temp
// workspace with test/mock-pi.mjs standing in for pi (CHRONOS_PI_LAUNCH_OVERRIDE),
// and drives the renderer through its CHRONOS_E2E test seams. Requires `npm run build`.
import { _electron as electron, test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(__dirname, "..", "..");
const mockPi = join(root, "test", "mock-pi.mjs");
// Under Node the electron package exports the path of its binary.
const electronPath = require("electron") as unknown as string;

let fixture: string;
let app: ElectronApplication;
let page: Page;
const consoleLines: string[] = [];
const pageErrors: string[] = [];

/** The renderer's test-state snapshot (window.__chronosTestState, CHRONOS_E2E only). */
function testState(p: Page): Promise<any> {
  return p.evaluate(() => (globalThis as any).__chronosTestState());
}

/** Deliver a __test/invoke to the renderer root, as the host would. */
function invoke(p: Page, action: string, arg?: string): Promise<void> {
  return p.evaluate(
    ([action, arg]) => (globalThis as any).document.querySelector("chronos-app").handleMessage({ type: "__test/invoke", action, arg }),
    [action, arg] as const,
  );
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fixture = mkdtempSync(join(tmpdir(), "chronos-e2e-"));
  mkdirSync(join(fixture, "sources", "TestSource", "png"), { recursive: true });
  copyFileSync(join(root, "resources", "icon.png"), join(fixture, "sources", "TestSource", "png", "page_0001.png"));
  for (const d of ["sessions", ".chronos", "memory", "data"]) mkdirSync(join(fixture, d), { recursive: true });
  writeFileSync(join(fixture, "memory", "MEMORY.MD"), "# memory\n");
  writeFileSync(join(fixture, "data", "rows.csv"), "a,b\n1,2\n");

  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, "out", "main.js"), "--workspace", fixture, "--no-sandbox", "--disable-gpu"],
    cwd: root,
    env: {
      ...(process.env as Record<string, string>),
      CHRONOS_PI_LAUNCH_OVERRIDE: JSON.stringify({ bin: process.execPath, args: [mockPi, "--mode", "rpc"] }),
      CHRONOS_E2E: "1",
    },
  });
  page = await app.firstWindow();
  page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

test("main window shows the three panes", async () => {
  await expect.poll(() => page.title()).toBe("Chronos");
  for (const sel of ["chronos-file-tree", "chronos-center-tabs", "chronos-chat"]) {
    await expect(page.locator(sel).first()).toBeVisible();
  }
});

test("the (mock) agent boots and reports its model", async () => {
  await expect.poll(async () => (await testState(page)).models?.[0]?.id, { timeout: 20_000 }).toBe("mock-model");
});

test("show_page renders through chronos-file://", async () => {
  await invoke(page, "sendPrompt", "select: TestSource");
  const img = page.locator("chronos-page-viewer img").first();
  await expect(img).toHaveAttribute("src", /^chronos-file:\/\/local\//);
  await expect.poll(() => img.evaluate((el) => (el as any).naturalWidth as number)).toBeGreaterThan(0);
});

test("streamed text renders", async () => {
  await invoke(page, "sendPrompt", "hello");
  await expect(page.locator("chronos-chat").getByText("echo: hello").first()).toBeVisible();
});

test("pending UI requests are cleared when the agent exits", async () => {
  await invoke(page, "sendPrompt", "ask: pick");
  const modal = page.locator("chronos-app .dialog[role=dialog]");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("pick");
  const pid = await app.evaluate(() => (globalThis as any).__chronosE2E?.agentPid() as number | undefined);
  expect(pid).toBeGreaterThan(0);
  process.kill(pid!);
  await expect(modal).toBeHidden();
  await expect(page.locator("chronos-chat #exit-banner")).toBeVisible();
});

test("no CSP violations, failed loads or page errors", async () => {
  const bad = consoleLines.filter((l) => /Refused to|Content Security Policy|Failed to load resource|net::ERR/.test(l));
  expect(bad).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("editor round trip: open MEMORY.MD", async () => {
  const path = join(fixture, "memory", "MEMORY.MD");
  await page.evaluate((path) => (globalThis as any).chronos.postMessage({ type: "file/open", path }), path);
  const editor = page.locator("chronos-code-editor").first();
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("# memory");
});
