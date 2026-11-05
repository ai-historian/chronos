import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readEnvFile, upsertEnvVar } from "../src/main/env-file";

test("readEnvFile returns {} for a missing file and parses KEY=value lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "chronos-env-"));
  try {
    assert.deepEqual(readEnvFile(join(dir, "nope.env")), {});
    const p = join(dir, ".env");
    writeFileSync(p, "# c\nA_KEY= v1 \nmixedCase=x\nnot a var\n");
    assert.deepEqual(readEnvFile(p), { A_KEY: "v1", mixedCase: "x" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upsertEnvVar replaces existing key and keeps mode 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "chronos-env-"));
  try {
    const p = join(dir, "sub", ".env");
    upsertEnvVar(p, "ANTHROPIC_API_KEY", "old");
    assert.equal(statSync(p).mode & 0o777, 0o600);
    chmodSync(p, 0o644);
    upsertEnvVar(p, "GEMINI_API_KEY", "g");
    upsertEnvVar(p, "ANTHROPIC_API_KEY", "new");
    assert.equal(statSync(p).mode & 0o777, 0o600);
    assert.equal(readFileSync(p, "utf-8"), "GEMINI_API_KEY=g\nANTHROPIC_API_KEY=new\n");
    assert.deepEqual(readEnvFile(p), { GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "new" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
