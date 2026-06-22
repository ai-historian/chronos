#!/usr/bin/env node
// Launches VS Code with the dev extension against a fixture workspace and runs
// test/suite.js inside the extension host. Uses the locally installed VS Code
// binary when available to avoid a download.
//
// Usage: node test/run-ui-test.mjs

import { runTests } from "@vscode/test-electron";
import { mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Drive the panel against a deterministic mock pi (no real agent / API keys).
// pi-rpc-session spawns the configured binary directly, so the mock needs the
// executable bit + its shebang.
const mockPi = join(extensionRoot, "test", "mock-pi.mjs");
chmodSync(mockPi, 0o755);

// Fixture workspace: one source; point Chronos at the mock pi.
const fixture = join(tmpdir(), `chronos-ui-test-${process.pid}`);
mkdirSync(join(fixture, "sources", "TestSource", "png"), { recursive: true });
mkdirSync(join(fixture, ".vscode"), { recursive: true });
mkdirSync(join(fixture, ".chronos"), { recursive: true });
writeFileSync(
  join(fixture, "sources", "TestSource", "png", "page_0001.png"),
  Buffer.from(
    "iVBORw0KGgoAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);
// A workspace skill — must surface in the / menu (the mock returns it only when
// the extension spawns pi with --skill <ws>/skills; see suite.js step 7).
mkdirSync(join(fixture, "skills", "range-finder"), { recursive: true });
writeFileSync(
  join(fixture, "skills", "range-finder", "SKILL.md"),
  "---\nname: range-finder\ndescription: Find the page range covering a given record type.\n---\n\n# Range Finder\n",
);
writeFileSync(join(fixture, ".vscode", "settings.json"), JSON.stringify({ "chronos.piPath": mockPi }, null, 2));
writeFileSync(join(fixture, ".chronos", ".env"), "");

const localCode = "/usr/share/code/code";

try {
  await runTests({
    ...(existsSync(localCode) ? { vscodeExecutablePath: localCode } : {}),
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: join(extensionRoot, "test", "suite.js"),
    extensionTestsEnv: { CHRONOS_SKIP_BOOTSTRAP: "1" },
    launchArgs: [fixture, "--disable-workspace-trust", "--disable-extensions"],
  });
  console.log("\nUI TEST OK");
} catch (err) {
  console.error("\nUI TEST FAILED:", err.message ?? err);
  process.exitCode = 1;
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
