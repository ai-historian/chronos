import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TreeHost, LAUNCHABLE_EXTENSIONS, isLaunchable } from "../src/main/tree-host";
import type { ExtToWebview } from "../src/shared/webview-protocol";

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chronos-treehost-")));
  mkdirSync(join(root, "sources", "coll", "Demo", "png"), { recursive: true });
  mkdirSync(join(root, "data"));
  mkdirSync(join(root, ".chronos"));
  writeFileSync(join(root, ".chronos", ".env"), "SECRET=1\n");
  writeFileSync(join(root, "sources", "coll", "Demo", "png", "page_0007.png"), "x");
  writeFileSync(join(root, "data", "x.csv"), "a\n");
  const posted: ExtToWebview[] = [];
  const calls: string[] = [];
  const host = new TreeHost({
    root,
    transport: { post: (m) => posted.push(m) },
    showPage: (s, p) => calls.push(`page ${s} ${p}`),
    os: {
      openPath: (p) => calls.push(`open ${p}`),
      showItemInFolder: (p) => calls.push(`reveal ${p}`),
      copyText: (t) => calls.push(`copy ${t}`),
    },
  });
  return { root, posted, calls, host };
}

test("start posts the root listing; expand replies with children", () => {
  const { root, posted, host } = setup();
  host.start();
  try {
    const first = posted[0];
    assert.equal(first.type, "tree");
    assert.deepEqual(first.type === "tree" && first.entries.map((e) => e.name), ["data", "sources"]);
    assert.equal(host.handle({ type: "tree/expand", path: join(root, "data") }), true);
    const last = posted.at(-1)!;
    assert.equal(last.type, "tree/children");
    assert.deepEqual(last.type === "tree/children" && last.entries.map((e) => e.name), ["x.csv"]);
  } finally {
    host.stop();
  }
});

test("renderer paths outside the workspace or under dot-dirs are rejected silently", () => {
  const { root, posted, calls, host } = setup();
  host.start();
  try {
    const n = posted.length;
    for (const path of [tmpdir(), join(root, ".."), join(root, ".chronos"), join(root, "data", "..", "..")]) {
      assert.equal(host.handle({ type: "tree/expand", path }), true);
      host.handle({ type: "file/open", path });
      host.handle({ type: "file/revealInOs", path });
      host.handle({ type: "file/copyPath", path });
    }
    assert.equal(posted.length, n);
    assert.deepEqual(calls, []);
  } finally {
    host.stop();
  }
});

test("file/open routes page PNGs to the viewer and everything else to the OS", () => {
  const { root, calls, host } = setup();
  host.handle({ type: "file/open", path: join(root, "sources", "coll", "Demo", "png", "page_0007.png") });
  host.handle({ type: "file/open", path: join(root, "data", "x.csv") });
  host.handle({ type: "file/revealInOs", path: join(root, "data") });
  host.handle({ type: "file/copyPath", path: join(root, "data", "x.csv") });
  assert.deepEqual(calls, [
    "page coll/Demo 7",
    `open ${join(root, "data", "x.csv")}`,
    `reveal ${join(root, "data")}`,
    `copy ${join(root, "data", "x.csv")}`,
  ]);
  assert.equal(host.handle({ type: "ready" }), false);
});

test("launchable files are revealed, never opened", () => {
  const { root, posted, calls, host } = setup();
  const sh = join(root, "data", "run.sh");
  const tool = join(root, "data", "tool");
  const docx = join(root, "data", "notes.docx");
  writeFileSync(sh, "echo hi\n");
  writeFileSync(tool, "#!/bin/sh\n");
  writeFileSync(docx, "x");
  chmodSync(sh, 0o644);
  chmodSync(docx, 0o644);
  if (process.platform !== "win32") chmodSync(tool, 0o755);
  assert.ok(LAUNCHABLE_EXTENSIONS.includes("exe") && LAUNCHABLE_EXTENSIONS.includes("sh"));
  assert.equal(isLaunchable(sh), true);
  assert.equal(isLaunchable(docx), false);
  host.handle({ type: "file/open", path: sh });
  if (process.platform !== "win32") host.handle({ type: "file/open", path: tool });
  host.handle({ type: "file/open", path: docx });
  const expected = [`reveal ${sh}`];
  if (process.platform !== "win32") expected.push(`reveal ${tool}`);
  expected.push(`open ${docx}`);
  assert.deepEqual(calls, expected);
  const notes = posted.filter((m) => m.type === "notify");
  assert.ok(notes.length >= 1);
  assert.ok(notes.every((m) => m.type === "notify" && m.level === "info" && m.message === "Executable files are revealed, not launched"));
});

test("symlinks into dot-dirs are rejected (checked on the realpath)", () => {
  const { root, posted, calls, host } = setup();
  const envlink = join(root, "data", "envlink");
  const cfg = join(root, "cfg");
  symlinkSync(join(root, ".chronos", ".env"), envlink);
  symlinkSync(join(root, ".chronos"), cfg);
  const n = posted.length;
  for (const path of [envlink, cfg]) {
    host.handle({ type: "file/open", path });
    host.handle({ type: "file/revealInOs", path });
    host.handle({ type: "file/copyPath", path });
    host.handle({ type: "tree/expand", path });
  }
  assert.deepEqual(calls, []);
  assert.equal(posted.length, n);
});

test("in-workspace symlinks resolve to the realpath for use", () => {
  const { root, calls, host } = setup();
  const link = join(root, "link.csv");
  symlinkSync(join(root, "data", "x.csv"), link);
  host.handle({ type: "file/copyPath", path: link });
  assert.deepEqual(calls, [`copy ${join(root, "data", "x.csv")}`]);
});
