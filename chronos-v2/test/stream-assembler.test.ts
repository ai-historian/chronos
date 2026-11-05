import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamAssembler } from "../src/renderer/stream-assembler";
import type { AssistantMessage } from "../src/main/rpc/rpc-types";

const empty = (): AssistantMessage => ({
  role: "assistant",
  content: [],
  provider: "p",
  model: "m",
  stopReason: "stop",
  timestamp: 1,
});

test("text deltas accumulate per contentIndex", () => {
  const a = new StreamAssembler();
  a.start(empty());
  a.apply({ type: "text_start", contentIndex: 0 });
  const m1 = a.apply({ type: "text_delta", contentIndex: 0, delta: "Hel" });
  const m2 = a.apply({ type: "text_delta", contentIndex: 0, delta: "lo" });
  assert.notEqual(m1, m2);
  assert.deepEqual(m1!.content, [{ type: "text", text: "Hel" }]);
  assert.deepEqual(m2!.content, [{ type: "text", text: "Hello" }]);
  assert.equal(a.current, m2);
});

test("thinking and text interleave by index", () => {
  const a = new StreamAssembler();
  a.start(empty());
  a.apply({ type: "thinking_start", contentIndex: 0 });
  a.apply({ type: "thinking_delta", contentIndex: 0, delta: "hm" });
  a.apply({ type: "text_start", contentIndex: 1 });
  a.apply({ type: "text_delta", contentIndex: 1, delta: "ok" });
  a.apply({ type: "toolcall_start", contentIndex: 2 });
  a.apply({ type: "toolcall_delta", contentIndex: 2, delta: '{"a"' });
  const mid = a.apply({ type: "thinking_delta", contentIndex: 0, delta: "m" });
  assert.deepEqual(mid!.content, [
    { type: "thinking", thinking: "hmm" },
    { type: "text", text: "ok" },
  ]);
  const done = a.apply({
    type: "toolcall_end",
    contentIndex: 2,
    toolCall: { type: "toolCall", id: "t1", name: "x", arguments: { a: 1 } },
  });
  assert.equal(done!.content.length, 3);
  assert.equal((done!.content[2] as any).name, "x");
});

test("end replaces with authoritative message", () => {
  const a = new StreamAssembler();
  a.start(empty());
  a.apply({ type: "text_delta", contentIndex: 0, delta: "partial" });
  const final = { ...empty(), content: [{ type: "text" as const, text: "final" }] };
  assert.equal(a.end(final), final);
  assert.equal(a.current, null);
});

test("apply before start is a no-op returning null", () => {
  const a = new StreamAssembler();
  assert.equal(a.apply({ type: "text_delta", contentIndex: 0, delta: "x" }), null);
  assert.equal(a.current, null);
});

test("usage from message_update is carried on the partial", () => {
  const a = new StreamAssembler();
  a.start(empty());
  const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 6 };
  const m = a.apply({ type: "text_delta", contentIndex: 0, delta: "x" }, usage);
  assert.deepEqual((m as any).usage, usage);
});
