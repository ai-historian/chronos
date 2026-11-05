import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, readdirSync, statSync, utimesSync, truncateSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDir, DirWatcher, readText, writeText, statMtime } from "../src/main/files";

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "chronos-files-")));
}

test("listDir hides dotdirs and sorts dirs first", () => {
  const root = tmp();
  for (const dir of ["sources", "data", ".chronos", ".pi"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, "b.md"), "hello");
  writeFileSync(join(root, "A.md"), "x");
  writeFileSync(join(root, ".importing.json"), "{}");
  const entries = listDir(root, root);
  assert.deepEqual(entries.map((e) => e.name), ["data", "sources", "A.md", "b.md"]);
  assert.deepEqual(entries[0], { path: join(root, "data"), name: "data", kind: "dir" });
  assert.equal(entries[3].size, 5);
  assert.equal(entries[3].kind, "file");
  assert.deepEqual(listDir(join(root, "data"), root), []);
});

test("listDir refuses outside root", () => {
  const root = tmp();
  const other = tmp();
  mkdirSync(join(root, "data"));
  assert.throws(() => listDir(other, root));
  assert.throws(() => listDir(join(root, ".."), root));
});

function waitFor<T>(events: T[], pred: (e: T) => boolean, ms = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const hit = events.find(pred);
      if (hit) {
        clearInterval(iv);
        resolve(hit);
      } else if (Date.now() - start > ms) {
        clearInterval(iv);
        reject(new Error(`timed out; got ${JSON.stringify(events)}`));
      }
    }, 20);
  });
}

test("DirWatcher emits add/unlink with debounce", async () => {
  const root = tmp();
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  const events: { path: string; kind: string }[] = [];
  const w = new DirWatcher(root, (e) => events.push(e));
  try {
    w.watch(dataDir);
    const file = join(dataDir, "x.csv");
    writeFileSync(file, "a,b\n");
    writeFileSync(join(dataDir, ".hidden"), "x");
    await waitFor(events, (e) => e.path === file && e.kind === "add");
    // debounce: the create + write burst collapses into one event for the path
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(events.filter((e) => e.path === file).length, 1);
    assert.ok(!events.some((e) => e.path.endsWith(".hidden")));
    rmSync(file);
    await waitFor(events, (e) => e.path === file && e.kind === "unlink");
  } finally {
    w.close();
  }
});

test("readText returns utf-8 content and mtime", () => {
  const root = tmp();
  const f = join(root, "MEMORY.MD");
  writeFileSync(f, "# Notes \u00e4\n");
  const r = readText(f);
  assert.equal(r.content, "# Notes \u00e4\n");
  assert.equal(r.mtimeMs, statSync(f).mtimeMs);
  assert.equal(statMtime(f), r.mtimeMs);
});

test("readText refuses > 20 MB", () => {
  const root = tmp();
  const f = join(root, "big.csv");
  writeFileSync(f, "");
  truncateSync(f, 20 * 1024 * 1024 + 1); // sparse: no 20 MB actually written
  assert.throws(() => readText(f), /20 MB/);
});

test("writeText atomic + returns new mtime", () => {
  const root = tmp();
  const f = join(root, "x.csv");
  writeFileSync(f, "a\n");
  chmodSync(f, 0o640);
  const before = readText(f);
  utimesSync(f, new Date(1_000_000), new Date(1_000_000)); // make the old mtime distinct
  const expected = statMtime(f);
  const r = writeText(f, "a,b\n1,2\n", expected);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.mtimeMs === statSync(f).mtimeMs);
  assert.ok(r.ok && r.mtimeMs !== expected);
  assert.equal(readFileSync(f, "utf8"), "a,b\n1,2\n");
  assert.deepEqual(readdirSync(root), ["x.csv"]); // no temp file left behind
  if (process.platform !== "win32") assert.equal(statSync(f).mode & 0o777, 0o640); // mode preserved
  assert.ok(before.mtimeMs > 0);
  // no expected mtime (or -1) skips the check
  assert.equal(writeText(f, "z", undefined).ok, true);
  assert.equal(writeText(f, "y", -1).ok, true);
  assert.equal(readFileSync(f, "utf8"), "y");
});

test("writeText with stale expectedMtime returns changed-on-disk", () => {
  const root = tmp();
  const f = join(root, "MEMORY.MD");
  writeFileSync(f, "v1");
  const { mtimeMs } = readText(f);
  // the agent rewrites the file meanwhile
  writeFileSync(f, "agent");
  utimesSync(f, new Date(mtimeMs + 5000), new Date(mtimeMs + 5000));
  const r = writeText(f, "mine", mtimeMs);
  assert.deepEqual(r, { ok: false, error: "changed-on-disk" });
  assert.equal(readFileSync(f, "utf8"), "agent");
});
