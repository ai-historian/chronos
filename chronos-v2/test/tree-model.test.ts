import { test } from "node:test";
import assert from "node:assert/strict";
import { TreeModel, compareEntries, type TreeEntry } from "../src/renderer/tree-model";

const d = (path: string): TreeEntry => ({ path, name: path.split("/").pop()!, kind: "dir" });
const f = (path: string, size = 1): TreeEntry => ({ path, name: path.split("/").pop()!, kind: "file", size });

test("compareEntries dirs first then locale", () => {
  const list = [f("/w/b.txt"), d("/w/zeta"), f("/w/A.txt"), d("/w/alpha")].sort(compareEntries);
  assert.deepEqual(list.map((e) => e.name), ["alpha", "zeta", "A.txt", "b.txt"]);
});

test("toggle expands/collapses and visible() flattens with depth", () => {
  const m = new TreeModel();
  m.setRoot("/w", [d("/w/data"), d("/w/sources"), f("/w/notes.md")]);
  assert.deepEqual(m.visible().map((v) => [v.entry.name, v.depth, v.expanded, v.loaded]), [
    ["data", 0, false, false],
    ["sources", 0, false, false],
    ["notes.md", 0, false, true],
  ]);
  assert.equal(m.toggle("/w/sources"), "expanded");
  assert.equal(m.isExpanded("/w/sources"), true);
  m.setChildren("/w/sources", [d("/w/sources/Demo")]);
  m.toggle("/w/sources/Demo");
  m.setChildren("/w/sources/Demo", [d("/w/sources/Demo/png")]);
  assert.deepEqual(m.visible().map((v) => [v.entry.name, v.depth]), [
    ["data", 0],
    ["sources", 0],
    ["Demo", 1],
    ["png", 2],
    ["notes.md", 0],
  ]);
  assert.equal(m.visible()[1].loaded, true);
  assert.equal(m.toggle("/w/sources"), "collapsed");
  assert.deepEqual(m.visible().map((v) => v.entry.name), ["data", "sources", "notes.md"]);
  // re-expanding keeps the nested expansion state
  m.toggle("/w/sources");
  assert.deepEqual(m.visible().map((v) => v.entry.name), ["data", "sources", "Demo", "png", "notes.md"]);
});

test("applyChange add inserts sorted / unlink removes subtree", () => {
  const m = new TreeModel();
  m.setRoot("/w", [d("/w/data"), d("/w/sources")]);
  m.toggle("/w/data");
  m.setChildren("/w/data", [f("/w/data/a.csv"), f("/w/data/c.csv")]);
  m.applyChange({ path: "/w/data/b.csv", kind: "add" });
  m.applyChange({ path: "/w/data/sub", kind: "add", entry: d("/w/data/sub") });
  assert.deepEqual(m.visible().map((v) => v.entry.name), ["data", "sub", "a.csv", "b.csv", "c.csv", "sources"]);
  // add under an unknown parent is ignored; duplicate add is idempotent
  m.applyChange({ path: "/w/nowhere/x.csv", kind: "add" });
  m.applyChange({ path: "/w/data/b.csv", kind: "add" });
  assert.equal(m.visible().length, 6);
  // change is a no-op
  m.applyChange({ path: "/w/data/a.csv", kind: "change" });
  assert.equal(m.visible().length, 6);
  // unlink drops the subtree and its expansion state
  m.toggle("/w/sources");
  m.setChildren("/w/sources", [d("/w/sources/Demo")]);
  m.toggle("/w/sources/Demo");
  m.applyChange({ path: "/w/sources", kind: "unlink" });
  assert.equal(m.isExpanded("/w/sources"), false);
  assert.equal(m.isExpanded("/w/sources/Demo"), false);
  assert.deepEqual(m.visible().map((v) => v.entry.name), ["data", "sub", "a.csv", "b.csv", "c.csv"]);
  m.applyChange({ path: "/w/data/a.csv", kind: "unlink" });
  assert.deepEqual(m.visible().map((v) => v.entry.name), ["data", "sub", "b.csv", "c.csv"]);
});
