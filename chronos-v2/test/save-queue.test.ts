import { test } from "node:test";
import assert from "node:assert/strict";
import { SaveQueue } from "../src/renderer/save-queue";

test("one save in flight per path; a second request queues (latest wins)", () => {
  const q = new SaveQueue();
  assert.deepEqual(q.request("/a", { content: "c1", force: false }), { content: "c1", force: false });
  assert.equal(q.inFlight("/a"), true);
  assert.equal(q.request("/a", { content: "c2", force: false }), null);
  assert.equal(q.request("/a", { content: "c3", force: false }), null);
  // other paths are independent
  assert.deepEqual(q.request("/b", { content: "b1", force: false }), { content: "b1", force: false });
  // the first reply reports what was actually written (c1) and hands back the latest queued save
  const r = q.settle("/a", true);
  assert.equal(r.written, "c1");
  assert.deepEqual(r.next, { content: "c3", force: false });
  assert.equal(q.inFlight("/a"), true); // the queued save is now in flight
  const r2 = q.settle("/a", true);
  assert.equal(r2.written, "c3");
  assert.equal(r2.next, null);
  assert.equal(q.inFlight("/a"), false);
});

test("a failed save drops the queued one and reports nothing written", () => {
  const q = new SaveQueue();
  q.request("/a", { content: "c1", force: false });
  q.request("/a", { content: "c2", force: false });
  const r = q.settle("/a", false);
  assert.equal(r.written, undefined);
  assert.equal(r.next, null);
  assert.equal(q.inFlight("/a"), false);
  assert.deepEqual(q.request("/a", { content: "c3", force: true }), { content: "c3", force: true });
});

test("an unsolicited reply writes nothing; busy tracks any in-flight save", () => {
  const q = new SaveQueue();
  assert.deepEqual(q.settle("/x", true), { written: undefined, next: null });
  assert.equal(q.busy, false);
  q.request("/x", { content: "1", force: false });
  assert.equal(q.busy, true);
  q.clear("/x");
  assert.equal(q.busy, false);
});
