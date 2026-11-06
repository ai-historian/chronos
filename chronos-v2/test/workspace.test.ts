import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace, isChronosWorkspace, RecentStore } from "../src/main/workspace";

const tmp = () => mkdtempSync(join(tmpdir(), "chronos-ws-"));

test("initWorkspace creates sources memory skills sessions .chronos .pi and MEMORY.MD", async () => {
  const d = tmp();
  await initWorkspace(d);
  for (const sub of ["sources", "memory", "skills", "sessions", ".chronos", ".pi"]) {
    assert.ok(existsSync(join(d, sub)), sub);
  }
  assert.ok(existsSync(join(d, "memory", "MEMORY.MD")));
  assert.deepEqual(JSON.parse(readFileSync(join(d, ".pi", "settings.json"), "utf8")), { skills: ["../skills"] });
  // idempotent: does not clobber existing files
  writeFileSync(join(d, "memory", "MEMORY.MD"), "keep");
  await initWorkspace(d);
  assert.equal(readFileSync(join(d, "memory", "MEMORY.MD"), "utf8"), "keep");
});

test("isChronosWorkspace", () => {
  const a = tmp();
  mkdirSync(join(a, "sources"));
  const b = tmp();
  mkdirSync(join(b, ".chronos"));
  const c = tmp();
  assert.equal(isChronosWorkspace(a), true);
  assert.equal(isChronosWorkspace(b), true);
  assert.equal(isChronosWorkspace(c), false);
  assert.equal(isChronosWorkspace(join(c, "nope")), false);
});

test("RecentStore dedupes, caps at 10, drops missing", () => {
  const root = tmp();
  const file = join(root, "recent.json");
  const dirs = Array.from({ length: 12 }, (_, i) => {
    const p = join(root, `w${i}`);
    mkdirSync(p);
    return p;
  });
  const s = new RecentStore(file);
  for (const p of dirs) s.add(p);
  s.add(dirs[5]); // dedupe, moves to front
  let l = s.list();
  assert.equal(l.length, 10);
  assert.equal(l[0].path, dirs[5]);
  assert.equal(l.filter((x) => x.path === dirs[5]).length, 1);
  assert.equal(l[1].path, dirs[11]);
  assert.ok(!l.some((x) => x.path === dirs[0]));
  // persisted
  assert.equal(new RecentStore(file).list().length, 10);
  // missing dirs dropped
  rmSync(dirs[11], { recursive: true });
  l = new RecentStore(file).list();
  assert.ok(!l.some((x) => x.path === dirs[11]));
  assert.equal(l.length, 9);
  assert.ok(!existsSync(file + ".tmp"));
});

test("RecentStore survives a corrupt or missing file", () => {
  const root = tmp();
  const file = join(root, "recent.json");
  assert.deepEqual(new RecentStore(file).list(), []);
  writeFileSync(file, "{not json");
  const s = new RecentStore(file);
  assert.deepEqual(s.list(), []);
  s.add(root);
  assert.equal(s.list().length, 1);
});
