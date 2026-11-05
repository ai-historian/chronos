import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAllowedPath, isAllowedPath, toChronosFileUrl, fromChronosFileUrl } from "../src/main/protocol-handler";

test("encodes non-ascii and spaces", () => {
  const p = "/w s/Kirchenbücher/png/page_0001.png";
  const url = toChronosFileUrl(p);
  assert.ok(url.startsWith("chronos-file://local/"));
  assert.ok(url.includes("Kirchenb%C3%BCcher"));
  assert.ok(url.includes("w%20s"));
  assert.equal(fromChronosFileUrl(url), p);
});

test("capitalised first segment round-trips", () => {
  const p = "/Users/Me/w s/Kirchenbücher/page_0001.png";
  assert.equal(fromChronosFileUrl(toChronosFileUrl(p), "linux"), p);
  assert.ok(toChronosFileUrl(p).startsWith("chronos-file://local/Users/Me/"));
});

test("host is ignored (Chromium-shaped urls)", () => {
  assert.equal(fromChronosFileUrl("chronos-file://local/Users/Me/a%20b.png", "darwin"), "/Users/Me/a b.png");
  assert.equal(fromChronosFileUrl("chronos-file://users/Me/a.png", "linux"), "/Me/a.png");
});

test("windows drive letter", () => {
  const u = toChronosFileUrl("C:\\Users\\x\\page_0001.png");
  assert.equal(u, "chronos-file://local/C:/Users/x/page_0001.png");
  assert.equal(fromChronosFileUrl(u, "win32"), "C:\\Users\\x\\page_0001.png");
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

test("rejects dangling symlink inside root", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ws-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "out-")));
  symlinkSync(join(outside, "later.png"), join(root, "dangling.png"));
  assert.equal(isAllowedPath(root, join(root, "dangling.png")), false);
  assert.equal(resolveAllowedPath([root], join(root, "dangling.png")), null);
});

test("resolveAllowedPath serves regular files only, as realpath", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ws-")));
  mkdirSync(join(root, "d"));
  writeFileSync(join(root, "d", "a.png"), "x");
  symlinkSync(join(root, "d", "a.png"), join(root, "alias.png"));
  assert.equal(resolveAllowedPath([root], join(root, "d")), null);
  assert.equal(resolveAllowedPath([root], join(root, "alias.png")), join(root, "d", "a.png"));
  assert.equal(resolveAllowedPath([], join(root, "d", "a.png")), null);
});
