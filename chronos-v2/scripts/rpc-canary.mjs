#!/usr/bin/env node
// Version canary: spawns the REAL pinned pi through buildPiLaunch (dev vendor
// paths, so it works before packaging) in a temp fixture workspace and asserts
//  1. get_state answers
//  2. the chronos agent loaded (select-source command registered)
//  3. get_available_models returns an array (no API key needed)
//  4. no slash command is named after a chronos/prompts/*.md file
// Runs under plain Node via tsx: `node --import tsx scripts/rpc-canary.mjs`.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildPiLaunch } from "../src/main/pi-launcher.ts";
import { resolveVendorPaths } from "../src/main/paths.ts";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "chronos-rpc-canary-"));
const workspace = join(tmp, "workspace");
mkdirSync(join(workspace, "sources", "TestSource", "png"), { recursive: true });
mkdirSync(join(workspace, "sessions"), { recursive: true });
writeFileSync(
  join(workspace, "sources", "TestSource", "png", "page_0001.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const vendor = resolveVendorPaths({ isPackaged: false, resourcesPath: "", appRoot });
// userDataDir is a temp dir, so PI_CODING_AGENT_DIR never touches ~/.pi.
const launch = buildPiLaunch({ vendor, workspaceDir: workspace, userDataDir: tmp, httpPort: 1, execPath: process.execPath });
console.log(`spawning ${launch.bin} ${launch.args.join(" ")}`);

const proc = spawn(launch.bin, launch.args, {
  cwd: workspace,
  env: { ...process.env, ...launch.env },
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
      continue;
    }
    for (const h of [...handlers]) h(msg);
  }
});

let nextId = 0;
function request(cmd, timeoutMs = 30_000) {
  const id = `c${++nextId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      handlers.splice(handlers.indexOf(h), 1);
      reject(new Error(`timeout waiting for ${cmd.type}\nstderr: ${stderr.slice(-2000)}`));
    }, timeoutMs);
    const h = (m) => {
      if (m.type === "response" && m.id === id) {
        clearTimeout(timer);
        handlers.splice(handlers.indexOf(h), 1);
        resolve(m);
      }
    };
    handlers.push(h);
    proc.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
  });
}

let failed = false;
function check(name, ok, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
}

try {
  const state = await request({ type: "get_state" });
  check("get_state answers", state.success === true, `model: ${state.data?.model?.id ?? "none"}`);

  const cmds = await request({ type: "get_commands" });
  const names = (cmds.data?.commands ?? []).map((c) => c.name);
  check("select-source registered", names.includes("select-source"), `${names.length} commands`);

  const models = await request({ type: "get_available_models" });
  const list = models.data?.models;
  check("get_available_models returns an array", Array.isArray(list), `${list?.length} models`);

  const promptNames = readdirSync(join(vendor.agentDir, "prompts"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
  const leaked = promptNames.filter((n) => names.includes(n));
  check("no prompt-file slash commands", leaked.length === 0, leaked.length ? `leaked: ${leaked.join(", ")}` : "");

  console.log(failed ? "\nCANARY FAILED" : `\nOK: state, select-source, ${list?.length} models`);
} catch (err) {
  console.error("CANARY ERROR:", err.message);
  failed = true;
} finally {
  proc.kill("SIGTERM");
  setTimeout(() => proc.kill("SIGKILL"), 1000).unref();
  rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
