import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
const out = join(__dirname, "..", "out");
test("build emits all bundles", () => {
  for (const f of ["main.js", "preload.js", "renderer/main.js", "renderer/main.css", "renderer/index.html", "renderer/welcome.js", "pdf-worker.js", "pdf-split-worker.js"])
    assert.ok(existsSync(join(out, f)), f);
});
