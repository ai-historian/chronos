import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAppLog, appendAppLog } from "../src/main/app-log";

test("rotates the previous log to chronos.log.1, keeping one", () => {
  const dir = mkdtempSync(join(tmpdir(), "chronos-logs-"));
  writeFileSync(join(dir, "chronos.log"), "run-2\n");
  writeFileSync(join(dir, "chronos.log.1"), "run-1\n");
  const file = installAppLog(dir);
  assert.equal(file, join(dir, "chronos.log"));
  assert.equal(readFileSync(join(dir, "chronos.log.1"), "utf-8"), "run-2\n");
  assert.equal(readFileSync(file, "utf-8"), "");
  assert.ok(!existsSync(join(dir, "chronos.log.2")));
});

test("console.error and appendAppLog land in the file, timestamped and formatted", () => {
  const dir = mkdtempSync(join(tmpdir(), "chronos-logs-"));
  const file = installAppLog(dir);
  console.error("[test] boom %d", 42, { a: 1 });
  appendAppLog("[pi] stderr line");
  const text = readFileSync(file, "utf-8");
  assert.match(text, /^\d{4}-\d\d-\d\dT[\d:.]+Z \[error\] \[test\] boom 42 \{ a: 1 \}$/m);
  assert.match(text, /^\S+ \[pi\] stderr line$/m);
});
