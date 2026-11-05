import { test } from "node:test";
import assert from "node:assert/strict";
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
