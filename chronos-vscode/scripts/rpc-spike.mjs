#!/usr/bin/env node
// Phase-1 spike / version canary for the pi RPC integration.
// Spawns `pi --mode rpc` in a fixture workspace and asserts:
//  1. pi answers get_state (readiness handshake works)
//  2. the chronos pi-package loaded (select-source command registered)
//  3. get_available_models returns models
//  4. `/select-source` (no arg) emits an extension_ui_request select,
//     and a cancelled extension_ui_response unblocks the agent.
//
// Usage: node scripts/rpc-spike.mjs [path-to-pi]

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const piBin = process.argv[2] ?? "pi";
const fixture = join(tmpdir(), `chronos-rpc-spike-${process.pid}`);
mkdirSync(join(fixture, "sources", "TestSource", "png"), { recursive: true });
mkdirSync(join(fixture, "sessions"), { recursive: true });
// 1x1 transparent PNG
writeFileSync(
  join(fixture, "sources", "TestSource", "png", "page_0001.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const proc = spawn(piBin, ["--mode", "rpc"], {
  cwd: fixture,
  env: { ...process.env, CHRONOS_HTTP_PORT: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let stderr = "";
const handlers = [];
proc.stderr.on("data", (c) => (stderr += c.toString()));
proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log("non-JSON stdout line:", line.slice(0, 120));
      continue;
    }
    for (const h of [...handlers]) h(msg);
  }
});

function send(obj) {
  proc.stdin.write(JSON.stringify(obj) + "\n");
}

function waitFor(predicate, label, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      handlers.splice(handlers.indexOf(handler), 1);
      reject(new Error(`timeout waiting for ${label}. stderr tail: ${stderr.slice(-500)}`));
    }, timeoutMs);
    const handler = (msg) => {
      if (predicate(msg)) {
        clearTimeout(timer);
        handlers.splice(handlers.indexOf(handler), 1);
        resolve(msg);
      }
    };
    handlers.push(handler);
  });
}

let reqId = 0;
async function request(cmd, timeoutMs) {
  const id = `req_${++reqId}`;
  const promise = waitFor((m) => m.type === "response" && m.id === id, cmd.type, timeoutMs);
  send({ ...cmd, id });
  return promise;
}

let failed = false;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
}

try {
  // 1. readiness: poll get_state
  let state = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !state) {
    try {
      const res = await request({ type: "get_state" }, 2000);
      if (res.success) state = res.data;
    } catch {
      if (proc.exitCode !== null) throw new Error(`pi exited early (code ${proc.exitCode}): ${stderr.slice(-500)}`);
    }
  }
  check("get_state readiness", !!state, state ? `session ${state.sessionId}, model ${state.model?.id ?? "none"}` : "");

  // 2. chronos pi-package loaded
  const commands = await request({ type: "get_commands" });
  const names = (commands.data?.commands ?? []).map((c) => c.name);
  check("chronos package loaded (select-source command)", names.includes("select-source"), `commands: ${names.join(", ")}`);

  // 3. models
  const models = await request({ type: "get_available_models" });
  check("get_available_models", (models.data?.models?.length ?? 0) > 0, `${models.data?.models?.length} models`);

  // 4. extension_ui_request round trip via /select-source.
  // NOTE: the prompt response for slash commands arrives only AFTER the
  // command handler finishes — i.e. after we answer the ui request.
  const uiReqPromise = waitFor((m) => m.type === "extension_ui_request" && m.method === "select", "ui select request");
  const promptResPromise = request({ type: "prompt", message: "/select-source" });
  const uiReq = await uiReqPromise;
  check("extension_ui_request emitted", uiReq.method === "select", `title: ${uiReq.title}, options: ${uiReq.options?.join("|")}`);
  check("fixture source listed", (uiReq.options ?? []).some((o) => o.includes("TestSource")));
  send({ type: "extension_ui_response", id: uiReq.id, cancelled: true });
  const promptRes = await promptResPromise;
  check("prompt response after cancelled ui reply", promptRes.success === true);
  // pi must stay responsive after the cancelled reply
  const after = await request({ type: "get_state" });
  check("agent responsive after cancelled ui response", after.success === true);

  console.log(failed ? "\nSPIKE FAILED" : "\nSPIKE OK");
} catch (err) {
  console.error("SPIKE ERROR:", err.message);
  failed = true;
} finally {
  proc.kill("SIGTERM");
  setTimeout(() => proc.kill("SIGKILL"), 1000).unref();
  rmSync(fixture, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
