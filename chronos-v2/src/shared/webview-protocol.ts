// Typed message protocol between the extension host and the Chronos webview.
// Imported by both bundles (src/ and webview/) — single source of truth.

import type { ThemeName } from "../main/theme";
import type {
  AgentEvent,
  AgentMessage,
  ModelInfo,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcSessionState,
  RpcSlashCommand,
  ThinkingLevel,
} from "../main/rpc/rpc-types";
import type { TreeEntry } from "../renderer/tree-model";

export type { TreeEntry };

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
  /** Count of USER prompts in the session (not assistant/tool messages). */
  messageCount: number;
  firstUserMessage?: string;
  sizeBytes?: number;
  /** pi session id (header.id) — keys the auto-name sidecar. */
  sessionId?: string;
  /** Explicit user-set name (pi session_info), if any. Absent → name is a fallback. */
  userName?: string;
}

export type ExtToWebview =
  // app theme (CSS variables text applied by the renderer)
  | { type: "theme"; name: ThemeName; css: string }
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
  // long-running host task (source import); one id per run, finished closes it
  | { type: "progress"; id: string; title: string; done: number; total?: number; message?: string; finished?: boolean }
  // inline tool-call approval (bash confirms intercepted from uiRequest)
  | { type: "permissionRequest"; id: string; command: string; suggestedPrefix: string }
  | { type: "yolo"; enabled: boolean }
  // workspace data
  | { type: "sources"; sources: { name: string; pageCount: number }[] }
  | { type: "sessions"; sessions: ChronosSessionInfo[] }
  | { type: "resumeResult"; ok: boolean }
  // auth: no models are available until the user connects a provider
  | { type: "loginRequired"; required: boolean }
  // open the in-app provider login dialog (id "other" = user names the env var)
  | { type: "login/open"; providers: { id: string; label: string; envVar: string }[] }
  // progress of the Claude-subscription OAuth sign-in
  | { type: "login/oauthStatus"; status: "waiting" | "done" | "error"; message?: string }
  // new session: clear the viewer + source dropdown so display matches selection
  | { type: "viewer/clearSource" }
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
  | { type: "viewer/updateRange"; firstPage: number; lastPage: number }
  // dataset viewer: files under the current source's data/ dir, and one file's content
  | { type: "data/list"; sourceName: string; files: string[] }
  | { type: "data/show"; sourceName: string; filename: string; content: string }
  // resolved page image for the data viewer's inline crop preview
  | { type: "data/sourcePreview"; imageUri: string; pageId: number; bbox: Bbox | null; sourceName: string }
  // application-menu driven UI actions
  | { type: "ui/openDrawer"; drawer: "history" }
  | { type: "ui/toggle"; pane: "tree" | "chat" }
  | { type: "ui/promptShowPage" }
  // workspace file tree: root listing, a dir's children (reply to tree/expand), watcher changes.
  // `entry` accompanies `add` so a new directory renders as one.
  | { type: "tree"; root: string; entries: TreeEntry[] }
  | { type: "tree/children"; path: string; entries: TreeEntry[] }
  | { type: "tree/changed"; path: string; kind: "add" | "unlink" | "change"; entry?: TreeEntry }
  // a file opened into a center tab (reply to file/open); for kind "image", content is a chronos-file:// URL
  | { type: "file/content"; path: string; content: string; mtimeMs: number; readOnly: boolean; kind: "text" | "image" }
  // reply to file/save; error "changed-on-disk" = the file's mtime no longer matches expectedMtimeMs
  | { type: "file/saved"; path: string; ok: boolean; mtimeMs?: number; error?: string }
  // test-only seam (integration tests): simulate a user action / request a state snapshot
  | { type: "__test/invoke"; action: string; arg?: string }
  | { type: "__test/dump" };

export type WebviewToExt =
  | { type: "ready" }
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "restartAgent" }
  | { type: "newSession" }
  // connect an AI provider: pick a provider, enter its API key, restart the agent
  | { type: "login" }
  // provider dialog: save an API key (then restart), start / feed / cancel Claude OAuth
  | { type: "login/apiKey"; envVar: string; key: string }
  | { type: "login/oauth" }
  | { type: "login/oauthCode"; code: string }
  | { type: "login/cancel" }
  | { type: "resumeSession"; sessionPath: string }
  | { type: "setModel"; provider: string; modelId: string }
  | { type: "setThinkingLevel"; level: ThinkingLevel }
  | { type: "selectSource"; name: string }
  | { type: "refreshSessions" }
  | { type: "refreshSources" }
  // import sources into the workspace (file-tree context menu; same flow as File ▸ Import)
  | { type: "workspace/import" }
  // workspace file tree (paths are absolute, validated against the workspace in main)
  | { type: "tree/expand"; path: string }
  | { type: "tree/collapse"; path: string }
  | { type: "tree/refresh" }
  | { type: "file/open"; path: string }
  | { type: "file/revealInOs"; path: string }
  | { type: "file/copyPath"; path: string }
  // save an editor tab; expectedMtimeMs -1 = overwrite without the on-disk change check
  | { type: "file/save"; path: string; content: string; expectedMtimeMs: number }
  | { type: "uiResponse"; response: RpcExtensionUIResponse }
  | { type: "permissionResponse"; id: string; action: "allow" | "always" | "deny"; prefix?: string }
  // edit a past user message: fork the session to just before it, then send
  // the edited text. occurrence disambiguates identical message texts.
  | { type: "editMessage"; originalText: string; occurrence: number; newText: string }
  | { type: "setYolo"; enabled: boolean }
  | { type: "viewer/navigate"; pageId: number }
  // menu "Show page…": open a page of a source by number
  | { type: "showPageRequest"; sourceName: string; pageId: number }
  | { type: "openViewLink"; pageId: number; bbox: Bbox | null; sourcePath?: string }
  // re-open a text file the agent showed earlier (the content isn't in the chat)
  | { type: "openTextView"; filePath: string; highlight: string | null }
  // dataset viewer requests
  | { type: "data/listRequest" }
  | { type: "data/load"; filename: string }
  // ask the host to resolve a cited page's image for the inline crop preview
  | { type: "data/previewSource"; pageId: number; bbox: Bbox | null; sourcePath?: string }
  // test-only seam: the webview's state snapshot, in reply to __test/dump
  | { type: "__test/state"; state: unknown };

// Welcome window (shown when no workspace is open). Shares the preload / window.chronos bridge.
export type WelcomeToExt =
  | { type: "workspace/open" }
  | { type: "workspace/create" }
  | { type: "workspace/openRecent"; path: string };

export type ExtToWelcome =
  | { type: "theme"; name: ThemeName; css: string }
  | { type: "workspace/recent"; items: { path: string; openedAt: number }[] };
