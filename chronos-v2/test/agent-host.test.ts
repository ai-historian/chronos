import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../src/main/agent-host";
import type { ExtToWebview } from "../src/shared/webview-protocol";

// 1x1 transparent PNG
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "chronos-agent-host-"));
  mkdirSync(join(dir, "sources", "TestSource", "png"), { recursive: true });
  writeFileSync(join(dir, "sources", "TestSource", "png", "page_0001.png"), PNG_1X1);
  mkdirSync(join(dir, "sessions"), { recursive: true });
  return dir;
}

function makeHost(workspaceDir: string) {
  const posted: ExtToWebview[] = [];
  const host = new AgentHost({
    workspaceDir,
    transport: { post: (m) => posted.push(m) },
    launch: (port) => ({
      bin: process.execPath,
      args: [join(__dirname, "mock-pi.mjs"), "--mode", "rpc"],
      env: { CHRONOS_HTTP_PORT: String(port) },
    }),
    imageUri: (p) => `test-img://${p}`,
  });
  return { host, posted };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

test("start seeds webview with state, models, commands, sources, sessions", async () => {
  const ws = makeWorkspace();
  const { host, posted } = makeHost(ws);
  try {
    await host.start();
    assert.equal(host.status, "ready");
    const want = ["state", "yolo", "sources", "sessions", "history", "models", "loginRequired", "commands"];
    await waitFor(() => want.every((t) => posted.some((m) => m.type === t)) || undefined);
    // state comes first, before the async model/command replies
    assert.equal(posted[0].type, "state");
    const sources = posted.find((m) => m.type === "sources");
    assert.deepEqual(sources && sources.type === "sources" && sources.sources, [{ name: "TestSource", pageCount: 1 }]);
    const login = posted.find((m) => m.type === "loginRequired");
    assert.equal(login && login.type === "loginRequired" && login.required, false);
  } finally {
    await host.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("show_page over http posts viewer/showPage with imageUri from callback", async () => {
  const ws = makeWorkspace();
  const { host, posted } = makeHost(ws);
  try {
    await host.start();
    await host.handleWebviewMessage({ type: "prompt", text: "select: TestSource" });
    const show = await waitFor(() => {
      const m = posted.find((x) => x.type === "viewer/showPage");
      return m && m.type === "viewer/showPage" ? m : undefined;
    });
    // mock-pi derives sourceDir from its cwd (the workspace), which is realpath'd.
    const page = join(realpathSync(ws), "sources", "TestSource", "png", "page_0001.png");
    assert.equal(show.imageUri, `test-img://${page}`);
    assert.equal(show.pageId, 1);
    assert.equal(show.sourceName, "TestSource");
    assert.equal(show.lastPage, 1);
  } finally {
    await host.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("exit cancels pending ui requests", async () => {
  const ws = makeWorkspace();
  const { host, posted } = makeHost(ws);
  try {
    await host.start();
    await host.handleWebviewMessage({ type: "prompt", text: "ask: pick one" });
    await waitFor(() => posted.find((m) => m.type === "uiRequest"));
    assert.equal(host.pendingUiRequestCount, 1);
    const pid = host.agentPid;
    assert.ok(pid);
    process.kill(pid, "SIGKILL");
    await waitFor(() => posted.find((m) => m.type === "agentExited"));
    assert.equal(host.status, "exited");
    assert.equal(host.pendingUiRequestCount, 0);
  } finally {
    await host.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("stop cancels pending ui requests and clears the set", async () => {
  const ws = makeWorkspace();
  const { host, posted } = makeHost(ws);
  try {
    await host.start();
    await host.handleWebviewMessage({ type: "prompt", text: "ask: pick one" });
    await waitFor(() => posted.find((m) => m.type === "uiRequest"));
    await host.stop();
    assert.equal(host.pendingUiRequestCount, 0);
    assert.equal(host.agentPid, undefined);
  } finally {
    await host.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("onStateChange fires after seeding and after setYolo", async () => {
  const ws = makeWorkspace();
  const { host } = makeHost(ws);
  const seen: { currentModel?: string; yolo: boolean; models: unknown[] }[] = [];
  const off = host.onStateChange((s) => seen.push(s));
  try {
    await host.start();
    const first = await waitFor(() => seen.find((s) => s.models.length > 0));
    assert.equal(first.currentModel, "mock/mock-model");
    assert.equal(first.yolo, false);
    await host.handleWebviewMessage({ type: "setYolo", enabled: true });
    assert.equal(seen[seen.length - 1].yolo, true);
  } finally {
    off();
    await host.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});
