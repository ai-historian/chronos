#!/usr/bin/env node
// Mock `pi --mode rpc` for chat-UI integration tests. Speaks the JSONL contract
// (src/main/rpc/rpc-types.ts): reads commands on stdin, writes responses + agent
// events on stdout. Behavior for `prompt` is keyed off the message text so one
// mock covers several scenarios. Never writes non-JSON to stdout.
//
// Scenarios (by message prefix):
//   "select: …"  → POST a show_page over HTTP (establishes the active source),
//                  then reply with assistant text "source selected".
//   "tool: …"    → emit a tool_execution_start/end (list_pages), then "done".
//   "ask: …"     → emit a blocking extension_ui_request (select) and wait for
//                  the extension_ui_response before replying "picked: <value>".
//                  A cancelled response is logged to stderr ("ui-cancelled <id>").
//   anything     → emit assistant text "echo: <message>".
import { createInterface } from "node:readline";
import { request } from "node:http";
import { join } from "node:path";

const MODEL = {
  id: "mock-model",
  name: "Mock Model",
  provider: "mock",
  reasoning: false,
  contextWindow: 100000,
  input: ["text", "image"],
};
let model = MODEL;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function respond(command, id, data) {
  if (!id) return;
  send({ type: "response", command, id, success: true, data });
}

// get_state shape of pi 1.5.0 (steeringMode/followUpMode/autoCompactionEnabled
// are present on the wire; the app ignores them).
function state() {
  return {
    model,
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    sessionId: "mock-session-1",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
}

// Run boundary as pi 1.5.0 emits it: agent_end closes the low-level run
// (willRetry says whether pi retries it), agent_settled says nothing more
// happens automatically.
function endRun(msg) {
  send({ type: "agent_end", messages: [msg], willRetry: false });
  send({ type: "agent_settled", aborted: false });
}

// Push a viewer event back to the extension (the agent→ext HTTP channel).
function httpPost(msg) {
  const port = process.env.CHRONOS_HTTP_PORT;
  if (!port) return;
  const body = JSON.stringify(msg);
  const req = request(
    {
      hostname: "127.0.0.1",
      port: Number(port),
      path: "/message",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    },
    (res) => res.resume(),
  );
  req.on("error", () => {});
  req.end(body);
}

function assistant(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "mock",
    model: "mock-model",
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };

// Streaming shape of pi >=0.84 (verified against 1.5.0): message_start with an
// empty, stopReason "pending" snapshot; delta-only message_update events carrying
// `assistantMessageEvent` + cumulative `usage`; message_end with the full message.
function emitAssistant(text) {
  const msg = assistant(text);
  const update = (assistantMessageEvent) =>
    send({ type: "message_update", usage: USAGE, assistantMessageEvent });
  const half = text.startsWith("echo: ") ? "echo: " : text;
  send({ type: "agent_start" });
  send({ type: "message_start", message: { ...msg, content: [], stopReason: "pending" } });
  update({ type: "text_start", contentIndex: 0 });
  update({ type: "text_delta", contentIndex: 0, delta: half });
  update({ type: "text_delta", contentIndex: 0, delta: text.slice(half.length) });
  update({ type: "text_end", contentIndex: 0, content: text });
  send({ type: "message_end", message: msg });
  endRun(msg);
}

function emitToolThenAssistant(toolName, text) {
  send({ type: "agent_start" });
  send({ type: "tool_execution_start", toolCallId: "tc-1", toolName, args: {} });
  send({
    type: "tool_execution_end",
    toolCallId: "tc-1",
    toolName,
    result: { content: [{ type: "text", text: "tool ok" }] },
    isError: false,
    durationMs: 1,
  });
  const msg = assistant(text);
  send({ type: "message_end", message: msg });
  endRun(msg);
}

// Blocking ui requests awaiting an extension_ui_response, keyed by id.
const pendingUi = new Map();
let uiSeq = 0;

function handlePrompt(message) {
  const m = (message || "").trim();
  if (m.startsWith("ask:")) {
    const uiId = `ui-${++uiSeq}`;
    pendingUi.set(uiId, (resp) => emitAssistant(resp.cancelled ? "cancelled" : `picked: ${resp.value}`));
    send({
      type: "extension_ui_request",
      id: uiId,
      method: "select",
      title: m.slice("ask:".length).trim() || "Pick one",
      options: ["a", "b"],
    });
  } else if (m.startsWith("select:")) {
    httpPost({
      type: "show_page",
      pageId: 1,
      totalPages: 1,
      sourceDir: join(process.cwd(), "sources", "TestSource"),
      sourceName: "TestSource",
      bbox: null,
    });
    emitAssistant("source selected");
  } else if (m.startsWith("tool:")) {
    emitToolThenAssistant("list_pages", "done");
  } else if (m.startsWith("showpage:")) {
    // A show_page tool call — the chat renders a re-open icon on its entry.
    send({ type: "agent_start" });
    send({
      type: "tool_execution_start",
      toolCallId: "tc-2",
      toolName: "show_page",
      args: { page_id: 1, bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0.1 } },
    });
    send({
      type: "tool_execution_end",
      toolCallId: "tc-2",
      toolName: "show_page",
      result: { content: [{ type: "text", text: "[view p.1]" }] },
      isError: false,
      durationMs: 1,
    });
    const msg = assistant("shown page 1");
    send({ type: "message_end", message: msg });
    endRun(msg);
  } else {
    emitAssistant(`echo: ${m}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  const { id, type } = cmd;
  switch (type) {
    case "extension_ui_response": {
      if (cmd.cancelled) process.stderr.write(`ui-cancelled ${id}\n`);
      const done = pendingUi.get(id);
      pendingUi.delete(id);
      done?.(cmd);
      break;
    }
    case "get_state":
      respond(type, id, state());
      break;
    case "get_available_models":
      respond(type, id, { models: [model] });
      break;
    case "get_commands":
      respond(type, id, { commands: [] });
      break;
    case "get_messages":
    case "get_fork_messages":
      respond(type, id, { messages: [] });
      break;
    case "get_available_thinking_levels":
      respond(type, id, { levels: ["off"] });
      break;
    case "clear_queue":
      respond(type, id, { steering: [], followUp: [] });
      break;
    case "set_model":
      model = { ...model, id: cmd.modelId, provider: cmd.provider };
      respond(type, id, {});
      break;
    case "prompt":
      // pi >=0.99: the response carries the input's disposition. A slash
      // command is "handled" (no run starts); anything else starts a run.
      handlePrompt(cmd.message);
      respond(type, id, { disposition: (cmd.message || "").trim().startsWith("/") ? "handled" : "started" });
      break;
    case "steer":
    case "follow_up":
      handlePrompt(cmd.message);
      respond(type, id, { disposition: "queued" });
      break;
    case "new_session":
    case "switch_session":
      respond(type, id, { cancelled: false });
      break;
    case "fork":
      respond(type, id, { text: "", cancelled: false });
      break;
    case "abort":
    case "compact":
    case "set_thinking_level":
    case "set_session_name":
      respond(type, id, {});
      break;
    default:
      respond(type || "unknown", id, {});
  }
});

// Stay alive until the parent kills us, even if stdin drains.
process.stdin.resume();
