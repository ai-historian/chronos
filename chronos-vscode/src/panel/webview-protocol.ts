// Typed message protocol between the extension host and the Chronos webview.
// Imported by both bundles (src/ and webview/) — single source of truth.

import type {
  AgentEvent,
  AgentMessage,
  ModelInfo,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcSessionState,
  RpcSlashCommand,
  ThinkingLevel,
} from "../rpc/rpc-types";

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChronosSessionInfo {
  path: string;
  name: string;
  timestamp: number;
  messageCount: number;
  firstUserMessage?: string;
  sizeBytes?: number;
}

export type ExtToWebview =
  // chat / agent
  | { type: "agentEvent"; event: AgentEvent }
  | { type: "state"; state: RpcSessionState }
  | { type: "models"; models: ModelInfo[] }
  | { type: "commands"; commands: RpcSlashCommand[] }
  | { type: "history"; messages: AgentMessage[] }
  | { type: "agentExited"; code: number | null; stderr: string }
  | { type: "agentRestarted" }
  | { type: "uiRequest"; request: RpcExtensionUIRequest }
  | { type: "notify"; level: "info" | "warning" | "error"; message: string }
  // inline tool-call approval (bash confirms intercepted from uiRequest)
  | { type: "permissionRequest"; id: string; command: string; suggestedPrefix: string }
  | { type: "yolo"; enabled: boolean }
  // workspace data
  | { type: "sources"; sources: { name: string; pageCount: number }[] }
  | { type: "sessions"; sessions: ChronosSessionInfo[] }
  | { type: "resumeResult"; ok: boolean }
  // viewer (image URI already resolved via asWebviewUri)
  | {
      type: "viewer/showPage";
      imageUri: string;
      pageId: number;
      sourceName: string;
      firstPage: number;
      lastPage: number;
      bbox: Bbox | null;
    }
  | {
      type: "viewer/showText";
      filePath: string;
      content: string;
      highlight: string | null;
      sourceName: string;
    }
  | { type: "viewer/updateRange"; firstPage: number; lastPage: number };

export type WebviewToExt =
  | { type: "ready" }
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "restartAgent" }
  | { type: "newSession" }
  | { type: "resumeSession"; sessionPath: string }
  | { type: "setModel"; provider: string; modelId: string }
  | { type: "setThinkingLevel"; level: ThinkingLevel }
  | { type: "selectSource"; name: string }
  | { type: "refreshSessions" }
  | { type: "refreshSources" }
  | { type: "uiResponse"; response: RpcExtensionUIResponse }
  | { type: "permissionResponse"; id: string; action: "allow" | "always" | "deny"; prefix?: string }
  // edit a past user message: fork the session to just before it, then send
  // the edited text. occurrence disambiguates identical message texts.
  | { type: "editMessage"; originalText: string; occurrence: number; newText: string }
  | { type: "setYolo"; enabled: boolean }
  | { type: "viewer/navigate"; pageId: number }
  | { type: "openViewLink"; pageId: number; bbox: Bbox | null; sourcePath?: string };
