import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TreeHost } from "../src/main/tree-host";
import type { ExtToWebview } from "../src/shared/webview-protocol";

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chronos-treehost-")));
  mkdirSync(join(root, "sources", "coll", "Demo", "png"), { recursive: true });
  mkdirSync(join(root, "data"));
  mkdirSync(join(root, ".chronos"));
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
