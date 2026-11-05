import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename, isAbsolute } from "node:path";
import { PiRpcSession } from "./rpc/pi-rpc-session";
import type { ModelInfo, RpcExtensionUIRequest, RpcSessionState, RpcSlashCommand, ThinkingLevel } from "./rpc/rpc-types";
import type { AgentToExtensionMessage } from "./protocol";
import type { Bbox, ExtToWebview, WebviewToExt } from "../shared/webview-protocol";
import { HttpServer } from "./http-server";
import { discoverSources, countPages } from "./sources";
import { listSessions, readSessionMessages } from "./sessions";
import { readChronosSettings, writeChronosSettings, suggestPrefix, commandMatchesPrefix } from "./chronos-settings";
import type { PiLaunch } from "./pi-launcher";
import type { Transport } from "./transport";

// Electron-free port of the VS Code extension's ChronosPanel: owns the
// `pi --mode rpc` subprocess (control plane), the loopback HTTP server the
// agent POSTs viewer events to (push channel), and the bridge to the renderer
// via a Transport. Host-specific effects (window title, focus, image URLs,
// how pi is launched) are injected through the constructor options.

export type AgentStatus = "idle" | "starting" | "ready" | "failed" | "exited";

export interface AgentHostState {
  models: ModelInfo[];
  currentModel?: string;
  thinking: ThinkingLevel;
  yolo: boolean;
}

export interface AgentHostOptions {
  workspaceDir: string;
  transport: Transport;
  /** Build the pi command line for the given HTTP push-channel port. */
  launch: (httpPort: number) => PiLaunch;
  /** Map an absolute page-image path to a URL the renderer can load. */
  imageUri: (absPath: string) => string;
  onTitle?: (t: string) => void;
  /** The agent is blocked on the user (dialog/approval) — bring the window forward. */
  onAttention?: () => void;
  /** Provider choices for the login dialog. */
  loginProviders?: () => { id: string; label: string; envVar: string }[];
  /** Provider-login handlers (API key / Claude OAuth), supplied by the Electron shell. */
  onLogin?: {
    apiKey(envVar: string, key: string): Promise<void>;
    oauthStart(): Promise<void>;
    oauthCode(code: string): void;
    cancel(): void;
  };
}

// pi auto-registers every .md in a package's prompts/ dir as a slash command,
// but the chronos package ships those files as agent-internal tool text (the
// system prompt, expert prompts, per-tool descriptions) — not user commands.
// They're the only "prompt"-source entries with package origin; the user's own
// global/project prompts are top-level, and skills/extension commands are
// genuinely user-facing. Hide package prompts; keep everything else.
function isUserCommand(c: RpcSlashCommand): boolean {
  return !(c.source === "prompt" && c.sourceInfo?.origin === "package");
}

export class AgentHost {
  private readonly workspaceDir: string;
  private readonly transport: Transport;
  private httpServer = new HttpServer();
  private rpc: PiRpcSession | null = null;
  private isStreaming = false;
  private agentStatus: AgentStatus = "idle";
  private lastErrorText = "";
  private webviewReady = false;

  // Cached for onStateChange subscribers (e.g. the app menu).
  private models: ModelInfo[] = [];
  private lastState: RpcSessionState | undefined;
  private stateListeners = new Set<(s: AgentHostState) => void>();

  // Viewer state so navigation and [view p.N] links without an explicit
  // source resolve against the current source.
  private currentSourceDir: string | undefined;
  private currentSourceName: string | undefined;
  private firstPage = 1;
  private lastPage = 1;
  // Last source we pushed a data-file list for, so navigation within a source
  // doesn't re-list on every page change.
  private lastDataSource: string | undefined;

  // Blocking extension_ui_requests forwarded to the webview; answered with
  // cancelled on stop so the agent never deadlocks.
  private pendingUiRequestIds = new Set<string>();

  // Pending __test/dump requests awaiting the webview's state snapshot.
  private testDumpResolvers: ((state: unknown) => void)[] = [];

  constructor(private readonly opts: AgentHostOptions) {
    this.workspaceDir = opts.workspaceDir;
    this.transport = opts.transport;
  }

  // ── introspection (tests / debugging) ─────────────────────────────────────

  get status(): AgentStatus {
    return this.agentStatus;
  }

  get agentPid(): number | undefined {
    return this.rpc?.pid;
  }

  get lastError(): string {
    return this.lastErrorText;
  }

  get isWebviewReady(): boolean {
    return this.webviewReady;
  }

  get pendingUiRequestCount(): number {
    return this.pendingUiRequestIds.size;
  }

  /** Re-scan sources/ and push the updated list to the webview. Called when an
   *  external action changes the source tree (e.g. the Import Sources command
   *  adds a new source) so the header picker reflects it without a reload. */
  refreshSources(): void {
    this.postSources();
  }

  onStateChange(cb: (s: AgentHostState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  private emitStateChange(): void {
    const model = this.lastState?.model;
    const s: AgentHostState = {
      models: this.models,
      currentModel: model ? `${model.provider}/${model.id}` : undefined,
      thinking: this.lastState?.thinkingLevel ?? "off",
      yolo: readChronosSettings(this.workspaceDir).yolo === true,
    };
    for (const cb of this.stateListeners) {
      try {
        cb(s);
      } catch (err) {
        console.error("[agent-host] state listener failed:", err);
      }
    }
  }

  // ── test seam (integration tests) ─────────────────────────────────────────
  /** Tell the webview to simulate a user action. */
  testInvoke(action: string, arg?: string): void {
    this.post({ type: "__test/invoke", action, arg });
  }

  /** Ask the webview for a state snapshot and resolve with it. */
  testDump(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("__test/dump timed out")), 5000);
      this.testDumpResolvers.push((state) => {
        clearTimeout(timer);
        resolve(state);
      });
      this.post({ type: "__test/dump" });
    });
  }

  private post(msg: ExtToWebview): void {
    this.transport.post(msg);
  }

  // ── agent lifecycle ───────────────────────────────────────────────────────

  /** Bind the HTTP push channel, spawn pi against it, and seed the webview. */
  async start(): Promise<void> {
    this.httpServer.onMessage((msg) => {
      try {
        this.handleHttpMessage(msg);
      } catch (err) {
        console.error(`[agent-host] Error handling ${msg.type}:`, err);
      }
    });
    await this.httpServer.start();
    await this.startAgent();
  }

  /** Cancel pending UI requests, stop pi, and close the HTTP server. */
  async stop(): Promise<void> {
    // Unblock any agent-side ctx.ui.* call still waiting on the webview
    for (const id of this.pendingUiRequestIds) {
      this.rpc?.sendUiResponse({ type: "extension_ui_response", id, cancelled: true });
    }
    this.pendingUiRequestIds.clear();
    const rpc = this.rpc;
    this.rpc = null;
    await rpc?.stop();
    this.isStreaming = false;
    this.agentStatus = "idle";
    this.httpServer.dispose();
    // A disposed server can't be re-bound; start() after stop() gets a fresh one.
    this.httpServer = new HttpServer();
  }

  private async startAgent(): Promise<void> {
    let launch: PiLaunch;
    try {
      launch = this.opts.launch(this.httpServer.port);
    } catch (err) {
      this.agentStatus = "failed";
      this.lastErrorText = (err as Error).message;
      this.post({ type: "agentExited", code: null, stderr: (err as Error).message });
      this.post({ type: "notify", level: "error", message: `Chronos: failed to start pi — ${(err as Error).message}` });
      return;
    }
    const rpc = new PiRpcSession({
      piBin: launch.bin,
      args: launch.args,
      workspaceDir: this.workspaceDir,
      env: launch.env,
    });
    this.rpc = rpc;

    rpc.onEvent((event) => {
      if (event.type === "agent_start") this.isStreaming = true;
      if (event.type === "agent_end") {
        this.isStreaming = false;
        // Message counts changed — keep the session list fresh
        this.postSessions();
        // The turn may have written new extraction files — refresh the Data tab.
        this.postDataFiles();
      }
      this.post({ type: "agentEvent", event });
    });
    rpc.onUiRequest((request) => void this.handleUiRequest(request));
    rpc.onExit((code, stderrTail) => {
      this.isStreaming = false;
      this.agentStatus = "exited";
      this.lastErrorText = stderrTail.trim();
      // The child is gone, so nothing can answer (or receive) the pending
      // requests — drop them so a restart doesn't inherit stale ids.
      this.pendingUiRequestIds.clear();
      this.post({ type: "agentExited", code, stderr: stderrTail.trim() });
    });

    try {
      this.agentStatus = "starting";
      const state = await rpc.start();
      this.agentStatus = "ready";
      this.seedWebview(state);
    } catch (err) {
      this.agentStatus = "failed";
      this.lastErrorText = (err as Error).message;
      console.error("[agent-host] pi startup failed:", (err as Error).message);
      this.post({ type: "agentExited", code: null, stderr: (err as Error).message });
      this.post({ type: "notify", level: "error", message: `Chronos: failed to start pi — ${(err as Error).message}` });
    }
  }

  async restart(): Promise<void> {
    await this.rpc?.stop();
    this.rpc = null;
    // The old process is gone; its blocking requests died with it.
    this.pendingUiRequestIds.clear();
    await this.startAgent();
    this.post({ type: "agentRestarted" });
    this.emitStateChange();
  }

  async newSession(): Promise<void> {
      const result = await this.rpc?.request<{ cancelled: boolean }>({ type: "new_session" }, 60_000);
      if (result && !result.cancelled) {
        this.currentSourceDir = undefined;
        this.currentSourceName = undefined;
        // Re-arm the Data-tab refresh guard so re-selecting the same source
        // (or restoring it on resume) repopulates the (now-cleared) Data tab.
        this.lastDataSource = undefined;
        this.post({ type: "history", messages: [] });
        // The new session has no source bound — clear the viewer + dropdown so
        // the display matches (don't leave the previous source showing).
        this.post({ type: "viewer/clearSource" });
        await this.refreshState();
        this.postSessions();
      }
  }

  /** Open a page of a workspace source by its name (e.g. from a menu or link). */
  showPageById(sourceName: string, pageId: number): void {
    const sourcesDir = join(this.workspaceDir, "sources");
    const source = existsSync(sourcesDir)
      ? discoverSources(sourcesDir).find((s) => s.name === sourceName)
      : undefined;
    if (!source) {
      this.post({ type: "notify", level: "warning", message: `Source not found: ${sourceName}` });
      return;
    }
    this.showPage(source.path, source.name, pageId, null, countPages(source.path));
  }

  private seedWebview(state: RpcSessionState): void {
    this.isStreaming = state.isStreaming;
    this.lastState = state;
    this.post({ type: "state", state });
    this.post({ type: "yolo", enabled: readChronosSettings(this.workspaceDir).yolo === true });
    this.postSources();
    this.postSessions();
    void this.postHistory(state);
    void this.rpc
      ?.request<{ models: ModelInfo[] }>({ type: "get_available_models" })
      .then((data) => {
        const models = data.models ?? [];
        this.models = models;
        this.post({ type: "models", models });
        // No models means no provider is authenticated — surface the login CTA.
        this.post({ type: "loginRequired", required: models.length === 0 });
        this.emitStateChange();
      })
      .catch(() => {
        // The agent already started (rpc.start resolved), so a transient
        // get_available_models failure shouldn't strand a stale "logged out"
        // banner after a successful login — clear it; the next re-seed corrects it.
        this.post({ type: "loginRequired", required: false });
        this.emitStateChange();
      });
    void this.rpc
      ?.request<{ commands: RpcSlashCommand[] }>({ type: "get_commands" })
      .then((data) => this.post({ type: "commands", commands: (data.commands ?? []).filter(isUserCommand) }))
      .catch(() => {});
  }

  // Vision tool results embed base64 page images — multi-MB payloads the chat
  // never renders. Strip them before crossing the postMessage bridge.
  private static stripImages(messages: any[]): any[] {
    return messages.map((msg) => {
      if (!msg || !Array.isArray(msg.content)) return msg;
      if (!msg.content.some((block: any) => block?.type === "image")) return msg;
      return {
        ...msg,
        content: msg.content.map((block: any) =>
          block?.type === "image" ? { type: "text", text: "[image]" } : block,
        ),
      };
    });
  }

  // History from the session file when it's richer than the agent context
  // (compaction trims the context on long sessions; the file keeps all turns).
  private async postHistory(state: RpcSessionState): Promise<void> {
    const filePath = state.sessionFile
      ? isAbsolute(state.sessionFile)
        ? state.sessionFile
        : join(this.workspaceDir, state.sessionFile)
      : undefined;
    const fromFile = filePath ? readSessionMessages(filePath) : undefined;
    try {
      const data = await this.rpc?.request<{ messages: any[] }>({ type: "get_messages" });
      const fromContext = data?.messages ?? [];
      const messages =
        fromFile && fromFile.length > fromContext.length ? fromFile : fromContext;
      this.post({ type: "history", messages: AgentHost.stripImages(messages) });
    } catch {
      if (fromFile) this.post({ type: "history", messages: AgentHost.stripImages(fromFile) });
    }
  }

  private postSources(): void {
    const sourcesDir = join(this.workspaceDir, "sources");
    const sources = existsSync(sourcesDir) ? discoverSources(sourcesDir) : [];
    this.post({
      type: "sources",
      sources: sources.map((s) => ({ name: s.name, pageCount: countPages(s.path) })),
    });
  }

  private postSessions(): void {
    this.post({ type: "sessions", sessions: listSessions(this.workspaceDir) });
  }

  private async refreshState(): Promise<void> {
    if (!this.rpc?.isRunning) return;
    try {
      const state = await this.rpc.request<RpcSessionState>({ type: "get_state" });
      this.isStreaming = state.isStreaming;
      this.lastState = state;
      this.post({ type: "state", state });
    } catch {
      // ignore
    }
  }

  // ── viewer ────────────────────────────────────────────────────────────────

  /** Messages from the chronos pi-package arriving over HTTP. */
  handleHttpMessage(msg: AgentToExtensionMessage): void {
    switch (msg.type) {
      case "show_page":
        this.showPage(msg.sourceDir, msg.sourceName, msg.pageId, msg.bbox, msg.totalPages);
        break;
      case "page_list":
        this.firstPage = msg.firstPage;
        this.lastPage = msg.lastPage;
        this.post({ type: "viewer/updateRange", firstPage: msg.firstPage, lastPage: msg.lastPage });
        break;
      case "show_text":
        this.currentSourceName = msg.sourceName;
        this.post({
          type: "viewer/showText",
          filePath: msg.filePath,
          content: msg.content,
          highlight: msg.highlight,
          sourceName: msg.sourceName,
        });
        break;
      // text_delta/tool_start/tool_end/turn_end are RPC-event duplicates — dropped
    }
  }

  showPage(sourceDir: string, sourceName: string, pageId: number, bbox: Bbox | null, totalPages?: number): void {
    this.currentSourceDir = sourceDir;
    this.currentSourceName = sourceName || this.currentSourceName;
    if (totalPages && totalPages > 0) {
      this.firstPage = 1;
      this.lastPage = totalPages;
    }

    this.post({
      type: "viewer/showPage",
      imageUri: this.pageImageUri(sourceDir, pageId),
      pageId,
      sourceName: this.currentSourceName ?? sourceName,
      firstPage: this.firstPage,
      lastPage: this.lastPage,
      bbox,
    });

    // Refresh the Data tab's file list when the active source changes.
    if (this.currentSourceName !== this.lastDataSource) this.postDataFiles();
  }

  // Resolve a page's image file (png/jpg/jpeg) to a webview URI.
  private pageImageUri(sourceDir: string, pageId: number): string {
    const pageBase = `page_${String(pageId).padStart(4, "0")}`;
    let pagePath = join(sourceDir, "png", pageBase + ".png");
    for (const ext of [".png", ".jpg", ".jpeg"]) {
      const candidate = join(sourceDir, "png", pageBase + ext);
      if (existsSync(candidate)) {
        pagePath = candidate;
        break;
      }
    }
    return this.opts.imageUri(pagePath);
  }

  // Resolve a cited page's image for the Data tab's inline crop preview, WITHOUT
  // touching the page viewer or current source — the data and source viewers are
  // independent; only "Show full page" (openViewLink) crosses over.
  private previewSource(pageId: number, bbox: Bbox | null, sourcePath?: string): void {
    let sourceDir = this.currentSourceDir;
    let sourceName = this.currentSourceName;
    if (sourcePath) {
      sourceDir = isAbsolute(sourcePath) ? sourcePath : join(this.workspaceDir, sourcePath);
      sourceName = basename(sourceDir);
    }
    if (!sourceDir) return;
    this.post({
      type: "data/sourcePreview",
      imageUri: this.pageImageUri(sourceDir, pageId),
      pageId,
      bbox,
      sourceName: sourceName ?? "",
    });
  }

  private openViewLink(pageId: number, bbox: Bbox | null, sourcePath?: string): void {
    let sourceDir = this.currentSourceDir;
    let sourceName = this.currentSourceName;
    if (sourcePath) {
      sourceDir = isAbsolute(sourcePath) ? sourcePath : join(this.workspaceDir, sourcePath);
      sourceName = basename(sourceDir);
    }
    if (!sourceDir || !sourceName) return;
    const totalPages = sourceDir === this.currentSourceDir ? undefined : countPages(sourceDir);
    this.showPage(sourceDir, sourceName, pageId, bbox, totalPages);
  }

  // Re-open a text file the agent showed earlier (show_text). The chat doesn't
  // keep the content, so re-read it here and push it to the viewer.
  private openTextView(filePath: string, highlight: string | null): void {
    const resolved = isAbsolute(filePath)
      ? filePath
      : this.currentSourceDir
        ? join(this.currentSourceDir, filePath)
        : undefined;
    if (!resolved) return;
    try {
      const content = readFileSync(resolved, "utf-8");
      this.post({
        type: "viewer/showText",
        filePath: resolved,
        content,
        highlight,
        sourceName: this.currentSourceName ?? basename(resolved),
      });
    } catch (err) {
      this.post({ type: "notify", level: "error", message: `Could not open ${filePath}: ${(err as Error).message}` });
    }
  }

  // ── dataset viewer ─────────────────────────────────────────────────────────
  // The agent writes extraction outputs to data/<sourceName>/ (sourceName is the
  // source dir basename, matching change_source / select-source). We surface
  // those files in the Data tab; row provenance reuses openViewLink.

  private dataDir(): string | undefined {
    return this.currentSourceName ? join(this.workspaceDir, "data", this.currentSourceName) : undefined;
  }

  private listDataFiles(): string[] {
    const dir = this.dataDir();
    if (!dir) return [];
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  private postDataFiles(): void {
    this.lastDataSource = this.currentSourceName;
    this.post({ type: "data/list", sourceName: this.currentSourceName ?? "", files: this.listDataFiles() });
  }

  private postDataFile(filename: string): void {
    const dir = this.dataDir();
    // filenames come from listDataFiles (basenames); reject anything path-like.
    if (!dir || filename.includes("/") || filename.includes("\\") || filename.includes("..")) return;
    try {
      const content = readFileSync(join(dir, filename), "utf-8");
      this.post({ type: "data/show", sourceName: this.currentSourceName ?? "", filename, content });
    } catch (err) {
      this.post({ type: "notify", level: "error", message: `Could not read ${filename}: ${(err as Error).message}` });
    }
  }

  // ── webview → extension ──────────────────────────────────────────────────

  async handleWebviewMessage(msg: WebviewToExt): Promise<void> {
    try {
      switch (msg.type) {
        case "ready": {
          // Webview (re)booted — re-seed if the agent is already up
          this.webviewReady = true;
          if (this.rpc?.isRunning) {
            const state = await this.rpc.request<RpcSessionState>({ type: "get_state" });
            this.seedWebview(state);
          }
          break;
        }
        case "prompt": {
          if (this.isStreaming) {
            await this.rpc?.request({ type: "steer", message: msg.text });
          } else {
            // No timeout: slash-command prompts (/select-source) only respond
            // after their handler finishes, which may wait on a user dialog.
            await this.rpc?.request({ type: "prompt", message: msg.text }, 0);
          }
          break;
        }
        case "abort":
          await this.rpc?.request({ type: "abort" });
          break;
        case "restartAgent":
          await this.restart();
          break;
        case "newSession":
          await this.newSession();
          break;
        case "login":
          this.post({ type: "login/open", providers: this.opts.loginProviders?.() ?? [] });
          break;
        case "login/apiKey":
          await this.opts.onLogin?.apiKey(msg.envVar, msg.key);
          break;
        case "login/oauth":
          await this.opts.onLogin?.oauthStart();
          break;
        case "login/oauthCode":
          this.opts.onLogin?.oauthCode(msg.code);
          break;
        case "login/cancel":
          this.opts.onLogin?.cancel();
          break;
        case "resumeSession": {
          try {
            const result = await this.rpc?.request<{ cancelled: boolean }>(
              { type: "switch_session", sessionPath: msg.sessionPath },
              120_000,
            );
            if (result && !result.cancelled && this.rpc) {
              const state = await this.rpc.request<RpcSessionState>({ type: "get_state" });
              this.isStreaming = state.isStreaming;
              this.post({ type: "state", state });
              await this.postHistory(state);
              this.post({ type: "resumeResult", ok: true });
            } else {
              this.post({ type: "resumeResult", ok: false });
            }
          } catch (err) {
            this.post({ type: "resumeResult", ok: false });
            throw err;
          }
          break;
        }
        case "setModel": {
          await this.rpc?.request({ type: "set_model", provider: msg.provider, modelId: msg.modelId });
          await this.refreshState();
          this.emitStateChange();
          break;
        }
        case "setThinkingLevel":
          await this.rpc?.request({ type: "set_thinking_level", level: msg.level });
          await this.refreshState();
          this.emitStateChange();
          break;
        case "selectSource":
          // Runs the chronos pi-package command; with an argument it selects
          // directly, with an older package it opens the interactive picker
          // (which arrives back here as an extension_ui_request).
          await this.rpc?.request({ type: "prompt", message: `/select-source ${msg.name}` }, 0);
          break;
        case "refreshSessions":
          this.postSessions();
          break;
        case "refreshSources":
          this.postSources();
          break;
        case "uiResponse":
          this.pendingUiRequestIds.delete(msg.response.id);
          this.rpc?.sendUiResponse(msg.response);
          break;
        case "permissionResponse": {
          this.pendingUiRequestIds.delete(msg.id);
          if (msg.action === "always") {
            const settings = readChronosSettings(this.workspaceDir);
            const prefix = msg.prefix ?? "";
            if (prefix) {
              settings.allowedCommands = [...new Set([...(settings.allowedCommands ?? []), prefix])];
              writeChronosSettings(this.workspaceDir, settings);
            }
          }
          this.rpc?.sendUiResponse({
            type: "extension_ui_response",
            id: msg.id,
            confirmed: msg.action !== "deny",
          });
          break;
        }
        case "editMessage": {
          try {
            const data = await this.rpc?.request<{ messages: { entryId: string; text: string }[] }>({
              type: "get_fork_messages",
            });
            const wanted = msg.originalText.trim();
            const matches = (data?.messages ?? []).filter((m) => m.text.trim() === wanted);
            const target = matches[msg.occurrence] ?? matches[matches.length - 1];
            if (!target) {
              throw new Error("Could not locate this message in the session — it may predate a fork.");
            }
            const forkResult = await this.rpc?.request<{ cancelled: boolean }>(
              { type: "fork", entryId: target.entryId },
              60_000,
            );
            if (!forkResult || forkResult.cancelled) {
              this.post({ type: "resumeResult", ok: false });
              break;
            }
            const state = await this.rpc!.request<RpcSessionState>({ type: "get_state" });
            this.isStreaming = state.isStreaming;
            this.post({ type: "state", state });
            await this.postHistory(state);
            this.post({ type: "resumeResult", ok: true });
            this.postSessions();
            // Now run the edited message on the rewound branch
            await this.rpc?.request({ type: "prompt", message: msg.newText }, 0);
          } catch (err) {
            this.post({ type: "resumeResult", ok: false });
            throw err;
          }
          break;
        }
        case "setYolo": {
          const settings = readChronosSettings(this.workspaceDir);
          settings.yolo = msg.enabled;
          writeChronosSettings(this.workspaceDir, settings);
          this.post({ type: "yolo", enabled: msg.enabled });
          this.emitStateChange();
          break;
        }
        case "viewer/navigate": {
          if (this.currentSourceDir && this.currentSourceName) {
            this.showPage(this.currentSourceDir, this.currentSourceName, msg.pageId, null);
          }
          break;
        }
        case "openViewLink":
          this.openViewLink(msg.pageId, msg.bbox, msg.sourcePath);
          break;
        case "openTextView":
          this.openTextView(msg.filePath, msg.highlight);
          break;
        case "data/listRequest":
          this.postDataFiles();
          break;
        case "data/load":
          this.postDataFile(msg.filename);
          break;
        case "data/previewSource":
          this.previewSource(msg.pageId, msg.bbox, msg.sourcePath);
          break;
        case "__test/state":
          this.testDumpResolvers.shift()?.(msg.state);
          break;
      }
    } catch (err) {
      this.post({ type: "notify", level: "error", message: (err as Error).message });
    }
  }

  // ── extension UI requests → webview dialogs ───────────────────────────────

  private async handleUiRequest(request: RpcExtensionUIRequest): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) return;
    switch (request.method) {
      case "confirm": {
        // Bash confirmations from the chronos pi-package hook get the inline
        // approval flow with a persistent allowlist instead of a dialog.
        const bashCommand =
          request.title === "Bash Command" && request.message.startsWith("Allow: ")
            ? request.message.slice("Allow: ".length)
            : undefined;
        if (bashCommand !== undefined) {
          const allowed = readChronosSettings(this.workspaceDir).allowedCommands ?? [];
          if (allowed.some((prefix) => commandMatchesPrefix(bashCommand, prefix))) {
            rpc.sendUiResponse({ type: "extension_ui_response", id: request.id, confirmed: true });
            return;
          }
          this.pendingUiRequestIds.add(request.id);
          this.post({
            type: "permissionRequest",
            id: request.id,
            command: bashCommand,
            suggestedPrefix: suggestPrefix(bashCommand),
          });
          this.opts.onAttention?.();
          return;
        }
        this.pendingUiRequestIds.add(request.id);
        this.post({ type: "uiRequest", request });
        this.opts.onAttention?.();
        break;
      }
      case "select":
      case "input":
      case "editor":
        this.pendingUiRequestIds.add(request.id);
        this.post({ type: "uiRequest", request });
        this.opts.onAttention?.();
        break;
      case "notify": {
        this.post({
          type: "notify",
          level: request.notifyType ?? "info",
          message: request.message,
        });
        break;
      }
      case "setTitle":
        this.opts.onTitle?.(request.title);
        break;
      default:
        // setStatus/setWidget/set_editor_text: fire-and-forget, no reply expected
        break;
    }
  }
}
