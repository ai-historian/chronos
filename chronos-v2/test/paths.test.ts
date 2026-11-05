import { test } from "node:test";
import assert from "node:assert/strict";
import { unpackedPath } from "../src/main/paths";

test("unpackedPath maps a path inside app.asar to app.asar.unpacked", () => {
  assert.equal(
    unpackedPath("/opt/Chronos/resources/app.asar/out/pdf-worker.js"),
    "/opt/Chronos/resources/app.asar.unpacked/out/pdf-worker.js",
  );
  assert.equal(
    unpackedPath("C:\\Program Files\\Chronos\\resources\\app.asar\\out\\pdf-split-worker.js"),
    "C:\\Program Files\\Chronos\\resources\\app.asar.unpacked\\out\\pdf-split-worker.js",
  );
});

test("unpackedPath leaves non-asar and already-unpacked paths alone", () => {
  assert.equal(unpackedPath("/repo/chronos-v2/out/pdf-worker.js"), "/repo/chronos-v2/out/pdf-worker.js");
  const unpacked = "/opt/Chronos/resources/app.asar.unpacked/out/pdf-worker.js";
  assert.equal(unpackedPath(unpacked), unpacked);
  // a directory merely named like the archive is not touched
  assert.equal(unpackedPath("/home/u/app.asarx/out/w.js"), "/home/u/app.asarx/out/w.js");
});
