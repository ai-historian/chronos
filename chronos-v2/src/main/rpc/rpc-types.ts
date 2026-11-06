// Local copies of the pi RPC wire types (pi-coding-agent v1.5.0 — dist/modes/rpc/rpc-types.d.ts,
// dist/modes/json-event.d.ts, pi-agent-core dist/types.d.ts, pi-ai dist/types.d.ts). Kept in-repo
// so the app bundle has no runtime dependency on the pi packages; the JSONL protocol is the
// contract. Only the commands, responses and events the app uses are typed in full; see
// docs/rpc-commands.md and docs/json.md in the pi package for the rest.

// ── pi-ai message shapes ────────────────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
}

// "pending" is the stopReason of the message_start snapshot while streaming;
// "deferred" is used for tool calls parked by a tool loadout.
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  provider: string;
  model: string;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: any;
  isError: boolean;
  timestamp: number;
}

// AgentMessage is Message | app-defined custom messages; custom messages have a
// `role` outside the known three — the UI renders only the known roles.
export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | { role: string; [key: string]: any };

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    /** pi ≥1.5: true when `total` is the provider's billed figure, not a catalog estimate. */
    totalFromProvider?: boolean;
  };
}

// Wire shape since pi 0.84 (unchanged through 1.5.0): `message_update` is
// delta-only — the SDK's cumulative `partial` snapshot is stripped — and
// consumers assemble the message between `message_start` and `message_end`.
// `toolcall_start` keeps the tool call's `id` and `toolName` on the wire.
export type AssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start" | "thinking_start"; contentIndex: number }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "text_end" | "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
  | { type: "done"; reason: string; message?: AssistantMessage }
  | { type: "error"; reason: string; error: AssistantMessage };

// ── pi-agent-core / session events ──────────────────────────────────────────

// `agent_end` closes one low-level run; pi may still retry, recover from
// overflow, or deliver queued steering/follow-up messages afterwards.
// `agent_settled` is the signal that nothing more will happen automatically.
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; willRetry?: boolean }
  | { type: "agent_settled"; aborted?: boolean }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; assistantMessageEvent: AssistantMessageEvent; usage?: Usage }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean; durationMs?: number };

// "max" was added in pi 1.x; pi clamps a level the current model does not
// support to the nearest available one (`set_thinking_level` never fails).
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// ── pi RPC protocol ─────────────────────────────────────────────────────────

// `get_available_models` returns full Model objects (rpc-mode, not the trimmed
// RpcClient ModelInfo) — only the fields the UI needs are typed here.
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean | "native" | "tool";
  contextWindow: number;
  input: ("text" | "image")[];
  [key: string]: any;
}

export type RpcCommand =
  | { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "steer"; message: string; images?: ImageContent[] }
  | { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
  | { id?: string; type: "abort" }
  | { id?: string; type: "clear_queue" }
  | { id?: string; type: "new_session"; parentSession?: string }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
  | { id?: string; type: "get_available_thinking_levels" }
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "fork"; entryId: string }
  | { id?: string; type: "get_fork_messages" }
  | { id?: string; type: "set_session_name"; name: string }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "get_commands" };

export interface RpcSlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  // origin "package" = shipped by an installed pi package; "top-level" = the
  // user's own global/project resource. Used to hide a package's internal
  // prompt templates (tool text) from the slash-command menu.
  sourceInfo?: { origin?: "package" | "top-level"; scope?: string; path?: string; source?: string; baseDir?: string };
}

export interface RpcSessionState {
  model?: ModelInfo;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  autoCompactionEnabled?: boolean;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  messageCount: number;
  pendingMessageCount: number;
}

// Since pi 0.99 a successful `prompt` response says what happened to the
// input: "handled" = an extension command or input handler consumed it (no run
// started — don't wait for agent events), "queued" = parked behind a running
// turn, "started" = a run began. `steer`/`follow_up` answer "handled"|"queued".
export type PromptDisposition = "handled" | "queued" | "started";
export type QueuedInputDisposition = "handled" | "queued";
export interface PromptResponseData {
  disposition: PromptDisposition;
}

export type RpcResponse =
  | { id?: string; type: "response"; command: string; success: true; data?: any }
  | { id?: string; type: "response"; command: string; success: false; error: string };

export type RpcExtensionUIRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines: string[] | undefined; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type RpcExtensionUIResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };
