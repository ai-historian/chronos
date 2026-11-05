import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAllowedPath, toChronosFileUrl, fromChronosFileUrl } from "../src/main/protocol-handler";

test("encodes non-ascii and spaces", () => {
  const p = "/w s/Kirchenbücher/png/page_0001.png";
  const url = toChronosFileUrl(p);
  assert.ok(url.startsWith("chronos-file:///"));
  assert.ok(url.includes("Kirchenb%C3%BCcher"));
  assert.ok(url.includes("w%20s"));
  assert.equal(fromChronosFileUrl(url), p);
});

test("tolerates host-form urls", () => {
  assert.equal(fromChronosFileUrl("chronos-file://a/b%20c/d.png"), "/a/b c/d.png");
});

test("rejects path outside root", () => {
  const root = mkdtempSync(join(tmpdir(), "ws-"));
  assert.equal(isAllowedPath(root, "/etc/passwd"), false);
  assert.equal(isAllowedPath(root, root + "2/x"), false);
});

test("rejects traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "ws-"));
  assert.equal(isAllowedPath(root, join(root, "..", "etc", "passwd")), false);
  assert.equal(isAllowedPath(root, root + "/../etc/passwd"), false);
});

test("allows nested", () => {
  const root = mkdtempSync(join(tmpdir(), "ws-"));
  mkdirSync(join(root, "sources", "D", "png"), { recursive: true });
  assert.equal(isAllowedPath(root, root), true);
  assert.equal(isAllowedPath(root, join(root, "sources", "D", "png", "page_0001.png")), true);
});

test("rejects symlink escape", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ws-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "out-")));
  symlinkSync(outside, join(root, "link"));
  assert.equal(isAllowedPath(root, join(root, "link", "secret.png")), false);
});
