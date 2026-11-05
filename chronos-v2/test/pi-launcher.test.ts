import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPiLaunch } from "../src/main/pi-launcher";
import { resolveVendorPaths } from "../src/main/paths";

test("launch args are passed unquoted as argv", () => {
  const l = buildPiLaunch({
    vendor: { piCli: "/x/cli.js", agentDir: "/a" },
    workspaceDir: "/w s/Kirchenbücher",
    userDataDir: "/u",
    httpPort: 4242,
    execPath: "/e",
  });
  assert.equal(l.bin, "/e");
  assert.deepEqual(l.args, ["/x/cli.js", "--mode", "rpc", "--extension", join("/a", "dist", "extensions")]);
  assert.equal(l.env.PI_CODING_AGENT_DIR, join("/u", "pi-agent"));
  assert.equal(l.env.PI_CODING_AGENT_SESSION_DIR, join("/w s/Kirchenbücher", "sessions"));
  assert.equal(l.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(l.env.PI_SKIP_VERSION_CHECK, "1");
  assert.equal(l.env.PI_TELEMETRY, "0");
  assert.equal(l.env.PI_OFFLINE, undefined);
  assert.equal(l.env.CHRONOS_HTTP_PORT, "4242");
  assert.deepEqual(Object.keys(l.env).sort(), [
    "CHRONOS_HTTP_PORT",
    "ELECTRON_RUN_AS_NODE",
    "PI_CODING_AGENT_DIR",
    "PI_CODING_AGENT_SESSION_DIR",
    "PI_SKIP_VERSION_CHECK",
    "PI_TELEMETRY",
  ]);
});

test("adds workspace skills dir and .env keys when present", () => {
  const ws = mkdtempSync(join(tmpdir(), "chronos-launch-"));
  try {
    mkdirSync(join(ws, "skills"));
    mkdirSync(join(ws, ".chronos"));
    writeFileSync(join(ws, ".chronos", ".env"), "# comment\nANTHROPIC_API_KEY=k\n");
    const l = buildPiLaunch({
      vendor: { piCli: "/x/cli.js", agentDir: "/a" },
      workspaceDir: ws,
      userDataDir: "/u",
      httpPort: 1,
      execPath: "/e",
    });
    assert.deepEqual(l.args.slice(-2), ["--skill", join(ws, "skills")]);
    assert.equal(l.args.length, 7);
    assert.equal(l.env.ANTHROPIC_API_KEY, "k");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("resolveVendorPaths packaged vs dev", () => {
  assert.deepEqual(resolveVendorPaths({ isPackaged: true, resourcesPath: "/res", appRoot: "/app" }), {
    piCli: join("/res", "vendor", "pi", "dist", "bundle", "cli.js"),
    agentDir: join("/res", "vendor", "chronos"),
  });
  assert.deepEqual(resolveVendorPaths({ isPackaged: false, resourcesPath: "", appRoot: "/repo/chronos-v2" }), {
    piCli: join("/repo/chronos-v2", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
    agentDir: join("/repo", "chronos"),
  });
});
