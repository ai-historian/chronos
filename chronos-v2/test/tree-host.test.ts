import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync, chmodSync, readFileSync, statSync, utimesSync, truncateSync } from "node:fs";
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
    imageUri: (p) => `img:${p}`,
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

test("file/open routes page PNGs to the viewer and unknown types to the OS", () => {
  const { root, calls, host } = setup();
  writeFileSync(join(root, "data", "notes.docx"), "x");
  chmodSync(join(root, "data", "notes.docx"), 0o644);
  host.handle({ type: "file/open", path: join(root, "sources", "coll", "Demo", "png", "page_0007.png") });
  host.handle({ type: "file/open", path: join(root, "data", "notes.docx") });
  host.handle({ type: "file/revealInOs", path: join(root, "data") });
  host.handle({ type: "file/copyPath", path: join(root, "data", "x.csv") });
  assert.deepEqual(calls, [
    "page coll/Demo 7",
    `open ${join(root, "data", "notes.docx")}`,
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

test("file/open of a .csv posts file/content text", () => {
  const { root, posted, calls, host } = setup();
  const csv = join(root, "data", "x.csv");
  chmodSync(csv, 0o644);
  host.handle({ type: "file/open", path: csv });
  assert.deepEqual(calls, []);
  const last = posted.at(-1)!;
  assert.deepEqual(last, { type: "file/content", path: csv, content: "a\n", mtimeMs: statSync(csv).mtimeMs, readOnly: false, kind: "text" });
  // other text types, including SKILL.md and upper-case extensions
  mkdirSync(join(root, "skills", "s"), { recursive: true });
  mkdirSync(join(root, "memory"));
  for (const f of [join(root, "skills", "s", "SKILL.md"), join(root, "memory", "MEMORY.MD"), join(root, "data", "a.yaml"), join(root, "data", "b.json")]) {
    writeFileSync(f, "x");
    chmodSync(f, 0o644);
    host.handle({ type: "file/open", path: f });
    const m = posted.at(-1)!;
    assert.ok(m.type === "file/content" && m.kind === "text" && m.path === f, f);
  }
});

test("file/open of a .png under data/ posts file/content image", () => {
  const { root, posted, calls, host } = setup();
  const png = join(root, "data", "crop.png");
  writeFileSync(png, "x");
  chmodSync(png, 0o644);
  host.handle({ type: "file/open", path: png });
  assert.deepEqual(calls, []);
  const last = posted.at(-1)!;
  assert.equal(last.type, "file/content");
  assert.ok(last.type === "file/content" && last.kind === "image" && last.readOnly === true && last.content === `img:${png}` && last.path === png);
  // a non-page image inside a source's png/ dir is not an image tab
  const thumb = join(root, "sources", "coll", "Demo", "png", "thumb.png");
  writeFileSync(thumb, "x");
  chmodSync(thumb, 0o644);
  host.handle({ type: "file/open", path: thumb });
  assert.deepEqual(calls, [`open ${thumb}`]);
});

test("file/open of an oversized text file notifies instead of crashing", () => {
  const { root, posted, host } = setup();
  const big = join(root, "data", "big.csv");
  writeFileSync(big, "");
  chmodSync(big, 0o644);
  truncateSync(big, 20 * 1024 * 1024 + 1);
  host.handle({ type: "file/open", path: big });
  const last = posted.at(-1)!;
  assert.ok(last.type === "notify" && last.level === "error", JSON.stringify(last));
});

test("file/save round trip through the host", () => {
  const { root, posted, host } = setup();
  const csv = join(root, "data", "x.csv");
  chmodSync(csv, 0o644);
  host.handle({ type: "file/open", path: csv });
  const opened = posted.at(-1)!;
  assert.ok(opened.type === "file/content");
  const mtime = opened.type === "file/content" ? opened.mtimeMs : 0;
  assert.equal(host.handle({ type: "file/save", path: csv, content: "a,b\n", expectedMtimeMs: mtime }), true);
  const saved = posted.at(-1)!;
  assert.deepEqual(saved, { type: "file/saved", path: csv, ok: true, mtimeMs: statSync(csv).mtimeMs });
  assert.equal(readFileSync(csv, "utf8"), "a,b\n");
});

test("save detects on-disk change", () => {
  const { root, posted, host } = setup();
  const csv = join(root, "data", "x.csv");
  host.handle({ type: "file/open", path: csv });
  const opened = posted.at(-1)!;
  const mtime = opened.type === "file/content" ? opened.mtimeMs : 0;
  // the agent rewrites the file
  writeFileSync(csv, "agent\n");
  utimesSync(csv, new Date(mtime + 5000), new Date(mtime + 5000));
  host.handle({ type: "file/save", path: csv, content: "mine\n", expectedMtimeMs: mtime });
  assert.deepEqual(posted.at(-1), { type: "file/saved", path: csv, ok: false, error: "changed-on-disk" });
  assert.equal(readFileSync(csv, "utf8"), "agent\n");
  // Overwrite: expectedMtimeMs -1 skips the check
  host.handle({ type: "file/save", path: csv, content: "mine\n", expectedMtimeMs: -1 });
  const ok = posted.at(-1)!;
  assert.ok(ok.type === "file/saved" && ok.ok);
  assert.equal(readFileSync(csv, "utf8"), "mine\n");
});

test("file/save outside the workspace or into dot-dirs is refused", () => {
  const { root, posted, host } = setup();
  const n = posted.length;
  const env = join(root, ".chronos", ".env");
  const envlink = join(root, "data", "envlink");
  symlinkSync(env, envlink);
  for (const path of [env, envlink, join(tmpdir(), "nope.txt"), join(root, "data", "missing.md")]) {
    assert.equal(host.handle({ type: "file/save", path, content: "PWNED", expectedMtimeMs: -1 }), true);
  }
  assert.equal(readFileSync(env, "utf8"), "SECRET=1\n");
  // each refusal is answered so the renderer is not left waiting
  const replies = posted.slice(n);
  assert.equal(replies.length, 4);
  assert.ok(replies.every((m) => m.type === "file/saved" && !m.ok));
});
