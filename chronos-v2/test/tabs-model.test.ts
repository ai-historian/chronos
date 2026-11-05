import { test } from "node:test";
import assert from "node:assert/strict";
import { TabsModel } from "../src/renderer/tabs-model";

test("seeds permanent page and data tabs with page active", () => {
  const m = new TabsModel();
  assert.deepEqual(m.tabs.map((t) => t.id), ["page", "data"]);
  assert.equal(m.activeId, "page");
  assert.equal(m.active.kind, "page");
});

test("close dirty tab requires confirm", () => {
  const m = new TabsModel();
  const t = m.open({ kind: "editor", path: "/ws/memory/MEMORY.MD", title: "MEMORY.MD", mtimeMs: 1 });
  m.markDirty(t.id, true);
  assert.equal(m.close(t.id), "needs-confirm");
  assert.ok(m.tabs.some((x) => x.id === t.id));
  m.markDirty(t.id, false);
  assert.equal(m.close(t.id), "closed");
  assert.ok(!m.tabs.some((x) => x.id === t.id));
});

test("open same path focuses existing", () => {
  const m = new TabsModel();
  const a = m.open({ kind: "editor", path: "/ws/data/x.csv", title: "x.csv" });
  assert.equal(a.id, "/ws/data/x.csv");
  assert.equal(m.activeId, a.id);
  m.activate("data");
  const again = m.open({ kind: "editor", path: "/ws/data/x.csv", title: "x.csv" });
  assert.equal(again, a);
  assert.equal(m.activeId, a.id);
  assert.equal(m.tabs.length, 3);
});

test("page and data tabs cannot close", () => {
  const m = new TabsModel();
  assert.equal(m.close("page"), "not-closable");
  assert.equal(m.close("data"), "not-closable");
  m.forceClose("page");
  m.forceClose("data");
  assert.deepEqual(m.tabs.map((t) => t.id), ["page", "data"]);
});

test("forceClose activates neighbour", () => {
  const m = new TabsModel();
  const a = m.open({ kind: "editor", path: "/a.md", title: "a.md" });
  const b = m.open({ kind: "image", path: "/b.png", title: "b.png" });
  const c = m.open({ kind: "editor", path: "/c.md", title: "c.md" });
  m.activate(b.id);
  m.markDirty(b.id, true);
  m.forceClose(b.id);
  assert.equal(m.activeId, c.id); // right neighbour
  m.forceClose(c.id);
  assert.equal(m.activeId, a.id); // last tab closed → left neighbour
  // closing an inactive tab keeps the active one
  const d = m.open({ kind: "editor", path: "/d.md", title: "d.md" });
  m.forceClose(a.id);
  assert.equal(m.activeId, d.id);
});

test("setMtime and markDirty update the tab; unknown ids are ignored", () => {
  const m = new TabsModel();
  const t = m.open({ kind: "editor", path: "/a.md", title: "a.md", mtimeMs: 5 });
  m.setMtime(t.id, 9);
  m.markDirty(t.id, true);
  assert.equal(t.mtimeMs, 9);
  assert.equal(t.dirty, true);
  m.activate("nope");
  m.markDirty("nope", true);
  assert.equal(m.activeId, t.id);
});
