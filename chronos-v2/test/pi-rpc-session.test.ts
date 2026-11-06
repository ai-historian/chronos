import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRpcSession } from "../src/main/rpc/pi-rpc-session";

const fixtureDir = __dirname;

test("starts mock pi with explicit args and answers get_state", async () => {
  const s = new PiRpcSession({
    piBin: process.execPath,
    args: [join(__dirname, "mock-pi.mjs"), "--mode", "rpc"],
    workspaceDir: fixtureDir,
    env: {},
  });
  const state = await s.start();
  assert.equal(state.model?.id, "mock-model");
  await s.stop();
});

test("spawns without a shell: paths with spaces and non-ASCII survive as single args", async () => {
  const base = mkdtempSync(join(tmpdir(), "chronos-rpc-"));
  const dir = join(base, "w s", "Kirchenbücher 1842");
  mkdirSync(dir, { recursive: true });
  try {
    // The script path itself contains a space and a non-ASCII char; the extra arg too.
    const script = join(dir, "mock pi.mjs");
    copyFileSync(join(__dirname, "mock-pi.mjs"), script);
    const s = new PiRpcSession({
      piBin: process.execPath,
      args: [script, "--mode", "rpc", "--workspace", dir],
      workspaceDir: dir,
      env: {},
    });
    const state = await s.start();
    assert.equal(state.model?.id, "mock-model");
    await s.stop();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
