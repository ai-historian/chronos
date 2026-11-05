import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAppSettings, writeAppSettings } from "../src/main/app-settings";

const dir = () => mkdtempSync(join(tmpdir(), "chronos-as-"));

test("round trip", () => {
  const d = dir();
  writeAppSettings(d, { theme: "dark" });
  assert.deepEqual(readAppSettings(d), { theme: "dark" });
});

test("missing file gives defaults", () => {
  assert.deepEqual(readAppSettings(dir()), { theme: "system" });
});

test("corrupt or invalid gives defaults", () => {
  const d = dir();
  writeFileSync(join(d, "settings.json"), "{nope");
  assert.deepEqual(readAppSettings(d), { theme: "system" });
  writeFileSync(join(d, "settings.json"), JSON.stringify({ theme: "purple" }));
  assert.deepEqual(readAppSettings(d), { theme: "system" });
});
