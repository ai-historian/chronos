import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDir, DirWatcher } from "../src/main/files";

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
