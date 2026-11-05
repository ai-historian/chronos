import { LitElement, html, nothing, type TemplateResult } from "lit";
import type {
  ModelInfo,
  RpcExtensionUIRequest,
  RpcSessionState,
} from "../../main/rpc/rpc-types";
import type {
  ChronosSessionInfo,
  ExtToWebview,
  WebviewToExt,
} from "../../shared/webview-protocol";
import type { ChronosChat } from "./chronos-chat";
import type { ChronosPageViewer } from "./page-viewer";
import type { ChronosDataViewer } from "./data-viewer";
import type { ChronosFileTree } from "./file-tree";
import "./chronos-chat";
import "./file-tree";
import "./page-viewer";
import "./data-viewer";
import "./provider-dialog";
import "./center-tabs";
import "./code-editor";
import type { ChronosCodeEditor } from "./code-editor";
import { TabsModel, type Tab } from "../tabs-model";
import type { ProviderOption, OauthStatusView } from "./provider-dialog";
import brandIcon from "../assets/chronos-icon.png";

interface ProgressEntry {
  id: string;
  title: string;
  done: number;
  total?: number;
  message?: string;
  finished?: boolean;
}

/** A pending center-tab decision: a dirty tab being closed, or a save refused because the file changed on disk. */
interface FileModal {
  kind: "close" | "conflict";
  id: string;
}

/** Persisted editor/image tabs (restored by re-opening each path). */
interface SavedTab {
  kind: "editor" | "image";
  path: string;
}

interface Toast {
  id: number;
  level: "info" | "warning" | "error";
  message: string;
}

export class ChronosApp extends LitElement {
  static properties = {
    state: { state: true },
    models: { state: true },
    sources: { state: true },
    sessions: { state: true },
    drawerOpen: { state: true },
    uiRequest: { state: true },
    toasts: { state: true },
    splitPct: { state: true },
    currentSource: { state: true },
    yolo: { state: true },
    contextTokens: { state: true },
    sessionLoading: { state: true },
    tabsRev: { state: true },
    fileModal: { state: true },
    loginRequired: { state: true },
    loginProviders: { state: true },
    oauthStatus: { state: true },
    chatHidden: { state: true },
    treeWidth: { state: true },
    treeHidden: { state: true },
    showPagePrompt: { state: true },
    progress: { state: true },
  };

  declare state: RpcSessionState | null;
  declare models: ModelInfo[];
  declare sources: { name: string; pageCount: number }[];
  declare sessions: ChronosSessionInfo[];
  declare drawerOpen: boolean;
  declare uiRequest: RpcExtensionUIRequest | null;
  declare toasts: Toast[];
  declare splitPct: number;
  declare currentSource: string;
  declare yolo: boolean;
  declare contextTokens: number;
  declare sessionLoading: { title?: string; name: string; sizeBytes?: number } | null;
  /** Bumped whenever `tabs` (a mutable model) changes, to re-render. */
  declare tabsRev: number;
  declare fileModal: FileModal | null;
  declare loginRequired: boolean;
  /** Non-null while the provider dialog is open. */
  declare loginProviders: ProviderOption[] | null;
  declare oauthStatus: OauthStatusView | null;
  declare chatHidden: boolean;
  /** File-tree pane width in px (160–480). */
  declare treeWidth: number;
  declare treeHidden: boolean;
  /** Non-null while the menu's "Show page…" prompt is open. */
  declare showPagePrompt: { source: string; page: string } | null;
  /** Running host tasks (source imports), keyed by progress id. */
  declare progress: Map<string, ProgressEntry>;

  private postMessage: (msg: WebviewToExt) => void = () => {};
  private uiRequestQueue: RpcExtensionUIRequest[] = [];

  // The agent that issued pending dialogs/permission cards is gone (exit or
  // restart); answering them would send stale ids to the next pi process.
  private clearPendingUiRequests(): void {
    this.uiRequest = null;
    this.uiRequestQueue = [];
    this.chat?.clearPendingRequests();
  }

  private toastSeq = 0;
  readonly tabs = new TabsModel();
  /** Initial content for editor tabs (the editor owns the live document). */
  private tabContent = new Map<string, { content: string; readOnly: boolean }>();
  /** Paths whose next file/content must replace the editor's text (Reload). */
  private pendingReload = new Set<string>();
  /** Paths to close once their in-flight save succeeds. */
  private pendingClose = new Set<string>();
  /** Content sent with the in-flight save, per path (becomes the saved baseline on success). */
  private savingContent = new Map<string, string>();
  /** Persisted tabs still being re-opened, and the tab to re-activate once it is back. */
  private restoringPaths = new Map<string, SavedTab["kind"]>();
  private restoredActive: string | null = null;
  /** Expanded tree dirs from saved UI state, applied once the tree element exists. */
  private restoredExpanded: string[] = [];

  constructor() {
    super();
    this.state = null;
    this.models = [];
    this.sources = [];
    this.sessions = [];
    this.drawerOpen = false;
    this.uiRequest = null;
    this.toasts = [];
    this.splitPct = 52;
    this.currentSource = "";
    this.yolo = false;
    this.contextTokens = 0;
    this.sessionLoading = null;
    this.tabsRev = 0;
    this.fileModal = null;
    this.loginRequired = false;
    this.loginProviders = null;
    this.oauthStatus = null;
    this.chatHidden = false;
    this.treeWidth = 240;
    this.treeHidden = false;
    this.showPagePrompt = null;
    this.progress = new Map();
  }

  // Context occupancy = what the next request will carry: fresh input +
  // cache-read (the cached prefix) + the latest output.
  private static usageTokens(message: any): number | undefined {
    const usage = message?.usage;
    if (!usage) return undefined;
    const tokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.output ?? 0);
    return tokens > 0 ? tokens : undefined;
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  setPostMessage(fn: (msg: WebviewToExt) => void): void {
    this.postMessage = fn;
  }

  restoreUiState(
    saved:
      | { splitPct?: number; treeWidth?: number; treeHidden?: boolean; expanded?: string[]; tabs?: SavedTab[]; activeTab?: string }
      | undefined,
  ): void {
    if (saved?.splitPct) this.splitPct = saved.splitPct;
    if (typeof saved?.treeWidth === "number") this.treeWidth = ChronosApp.clampTree(saved.treeWidth);
    if (typeof saved?.treeHidden === "boolean") this.treeHidden = saved.treeHidden;
    if (Array.isArray(saved?.expanded)) this.restoredExpanded = saved.expanded.filter((p) => typeof p === "string");
    if (Array.isArray(saved?.tabs)) {
      for (const t of saved.tabs) {
        if (t && typeof t.path === "string" && (t.kind === "editor" || t.kind === "image")) this.restoringPaths.set(t.path, t.kind);
      }
    }
    if (saved?.activeTab === "data") this.tabs.activate("data");
    else if (typeof saved?.activeTab === "string" && this.restoringPaths.has(saved.activeTab)) this.restoredActive = saved.activeTab;
  }

  getUiState(): {
    splitPct: number;
    treeWidth: number;
    treeHidden: boolean;
    expanded: string[];
    tabs: SavedTab[];
    activeTab: string;
  } {
    const open: SavedTab[] = this.tabs.tabs.flatMap((t) =>
      (t.kind === "editor" || t.kind === "image") && t.path ? [{ kind: t.kind, path: t.path }] : [],
    );
    // Tabs not yet back from a restore are still part of the saved layout.
    for (const [path, kind] of this.restoringPaths) if (!open.some((t) => t.path === path)) open.push({ kind, path });
    return {
      splitPct: this.splitPct,
      treeWidth: this.treeWidth,
      treeHidden: this.treeHidden,
      expanded: this.tree?.expandedPaths() ?? this.restoredExpanded,
      tabs: open,
      activeTab: this.restoredActive ?? this.tabs.activeId,
    };
  }

  /** For the integration test seam / older callers: the active tab's id ("page", "data" or a path). */
  get viewerTab(): string {
    return this.tabs.activeId;
  }

  private static clampTree(px: number): number {
    return Math.max(160, Math.min(480, Math.round(px)));
  }

  private get tree(): ChronosFileTree | null {
    return this.querySelector("chronos-file-tree");
  }

  private get chat(): ChronosChat | null {
    return this.querySelector("chronos-chat");
  }

  private get viewer(): ChronosPageViewer | null {
    return this.querySelector("chronos-page-viewer");
  }

  private get dataViewer(): ChronosDataViewer | null {
    return this.querySelector("chronos-data-viewer");
  }

  handleMessage(msg: ExtToWebview): void {
    switch (msg.type) {
      case "agentEvent": {
        this.chat?.handleAgentEvent(msg.event);
        const event = msg.event;
        if (event.type === "message_end" && (event.message as any)?.role === "assistant") {
          const tokens = ChronosApp.usageTokens(event.message);
          if (tokens) this.contextTokens = tokens;
        }
        break;
      }
      case "state":
        this.state = msg.state;
        this.chat?.applyState(msg.state);
        break;
      case "models":
        this.models = msg.models;
        break;
      case "loginRequired":
        this.loginRequired = msg.required;
        break;
      case "login/open":
        this.oauthStatus = null;
        this.loginProviders = msg.providers;
        break;
      case "login/oauthStatus":
        if (msg.status === "done") {
          this.loginProviders = null;
          this.oauthStatus = null;
          this.pushToast("info", msg.message ?? "Connected. Restarting agent…");
        } else {
          this.oauthStatus = { status: msg.status, message: msg.message };
        }
        break;
      case "viewer/clearSource":
        // New session has no source bound — reset the display to match.
        this.currentSource = "";
        this.viewer?.clearSource();
        this.dataViewer?.clearSource();
        this.activateTab("page");
        break;
      case "commands":
        this.chat?.setCommands(msg.commands);
        break;
      case "history": {
        this.chat?.loadHistory(msg.messages);
        // Seed the context meter from the newest assistant usage on record
        this.contextTokens = 0;
        for (let i = msg.messages.length - 1; i >= 0; i--) {
          const tokens = ChronosApp.usageTokens(msg.messages[i]);
          if (tokens && (msg.messages[i] as any).role === "assistant") {
            this.contextTokens = tokens;
            break;
          }
        }
        // Keep the loading overlay up until the transcript is actually
        // painted — Lit commit first, then two frames for layout/paint.
        if (this.sessionLoading) {
          void this.chat?.updateComplete.then(() => {
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                this.sessionLoading = null;
              }),
            );
          });
        }
        break;
      }
      case "agentExited":
        this.clearPendingUiRequests();
        this.chat?.handleAgentExited(msg.code, msg.stderr);
        break;
      case "agentRestarted":
        this.clearPendingUiRequests();
        this.chat?.handleAgentRestarted();
        break;
      case "uiRequest":
        if (this.uiRequest) {
          this.uiRequestQueue.push(msg.request);
        } else {
          this.uiRequest = msg.request;
        }
        break;
      case "notify":
        this.pushToast(msg.level, msg.message);
        break;
      case "progress":
        this.updateProgress(msg);
        break;
      case "permissionRequest":
        this.chat?.addPermissionRequest({ id: msg.id, command: msg.command, suggestedPrefix: msg.suggestedPrefix });
        break;
      case "yolo":
        this.yolo = msg.enabled;
        break;
      case "ui/openDrawer":
        this.openHistoryDrawer();
        break;
      case "ui/toggle":
        if (msg.pane === "chat") this.chatHidden = !this.chatHidden;
        else this.treeHidden = !this.treeHidden;
        this.dispatchEvent(new CustomEvent("ui-state-changed", { bubbles: true }));
        break;
      case "tree":
        this.tree?.setRoot(msg.root, msg.entries);
        break;
      case "tree/children":
        this.tree?.setChildren(msg.path, msg.entries);
        break;
      case "tree/changed":
        this.tree?.applyChange(msg);
        break;
      case "ui/promptShowPage":
        this.showPagePrompt = { source: this.currentSource || this.sources[0]?.name || "", page: "1" };
        break;
      case "sources":
        this.sources = msg.sources;
        break;
      case "sessions":
        this.sessions = msg.sessions;
        break;
      case "resumeResult":
        if (!msg.ok) {
          // Failure/cancel: nothing else will arrive — drop the overlay now.
          this.sessionLoading = null;
        } else if (this.sessionLoading) {
          // Success: the history handler clears after paint; this is a backstop
          // in case no history message ever lands.
          setTimeout(() => {
            this.sessionLoading = null;
          }, 15_000);
        }
        break;
      case "viewer/showPage":
        this.currentSource = msg.sourceName;
        // An explicit page (agent or a data-row "view source" click) brings the
        // Page tab forward so the cited region is visible.
        this.activateTab("page");
        this.viewer?.showPage(msg.imageUri, msg.pageId, msg.sourceName, msg.firstPage, msg.lastPage, msg.bbox);
        break;
      case "viewer/showText":
        this.activateTab("page");
        this.viewer?.showText(
          { filePath: msg.filePath, content: msg.content, highlight: msg.highlight },
          msg.sourceName,
        );
        break;
      case "viewer/updateRange":
        this.viewer?.updateRange(msg.firstPage, msg.lastPage);
        break;
      case "data/list":
        this.dataViewer?.setFiles(msg.sourceName, msg.files);
        break;
      case "data/show":
        this.dataViewer?.showFile(msg.filename, msg.content);
        break;
      case "data/sourcePreview":
        this.dataViewer?.showSourcePreview(msg.imageUri, msg.pageId, msg.bbox, msg.sourceName);
        break;
      case "file/content":
        this.onFileContent(msg);
        break;
      case "file/saved":
        this.onFileSaved(msg);
        break;
      case "__test/invoke":
        this.runTestAction(msg.action, msg.arg);
        break;
      case "__test/dump":
        this.postMessage({ type: "__test/state", state: this.collectTestState() });
        break;
    }
  }

  // ── test seam (integration tests drive the UI via the host) ───────────────

  private runTestAction(action: string, arg?: string): void {
    switch (action) {
      case "sendPrompt":
        this.chat?.testSubmit(arg ?? "");
        break;
      case "openDataTab":
        this.activateTab("data");
        break;
      case "openPageTab":
        this.activateTab("page");
        break;
      case "newSession":
        this.postMessage({ type: "newSession" });
        break;
      case "injectExpertTools":
        this.chat?.testInjectExpertWithTools();
        break;
      case "selectDataFile":
        if (arg) this.dataViewer?.testSelect(arg);
        break;
      case "viewFirstRow":
        this.dataViewer?.testViewFirstRow();
        break;
      case "showFullPage":
        this.dataViewer?.testShowFullPage();
        break;
      case "clickReopen":
        this.querySelector<HTMLButtonElement>(".view-reopen")?.click();
        break;
    }
  }

  private collectTestState(): unknown {
    return {
      currentSource: this.currentSource,
      viewerTab: this.viewerTab,
      tabs: this.tabs.tabs.map((t) => ({ id: t.id, kind: t.kind, dirty: t.dirty })),
      chat: this.chat?.testSnapshot() ?? null,
      viewer: this.viewer?.testSnapshot() ?? null,
      data: this.dataViewer?.testSnapshot() ?? null,
    };
  }

  private pushToast(level: Toast["level"], message: string): void {
    const toast: Toast = { id: ++this.toastSeq, level, message };
    this.toasts = [...this.toasts, toast];
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== toast.id);
    }, level === "error" ? 10_000 : 5_000);
  }

  private answerUiRequest(response: { value: string } | { confirmed: boolean } | { cancelled: true }): void {
    if (!this.uiRequest) return;
    this.postMessage({
      type: "uiResponse",
      response: { type: "extension_ui_response", id: this.uiRequest.id, ...response } as any,
    });
    this.uiRequest = this.uiRequestQueue.shift() ?? null;
  }

  // ── center tabs ───────────────────────────────────────────────────────────

  private tabsChanged(): void {
    this.tabsRev++;
    this.dispatchEvent(new CustomEvent("ui-state-changed", { bubbles: true }));
  }

  private activateTab(id: string): void {
    const changed = this.tabs.activeId !== id;
    this.tabs.activate(id);
    // Selecting Data (even when already selected) refreshes its file list, as before.
    if (this.tabs.activeId === "data") this.postMessage({ type: "data/listRequest" });
    if (changed) this.tabsChanged();
  }

  private editorFor(path: string): ChronosCodeEditor | undefined {
    return [...this.querySelectorAll("chronos-code-editor")].find((e) => e.path === path);
  }

  private static basename(path: string): string {
    return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) || path;
  }

  private onFileContent(msg: Extract<ExtToWebview, { type: "file/content" }>): void {
    const restoring = this.restoringPaths.delete(msg.path);
    const prevActive = this.tabs.activeId;
    const existing = this.tabs.tabs.find((t) => t.path === msg.path);
    if (existing && existing.kind === "editor" && msg.kind === "text") {
      // Re-opening an open file only replaces its text when asked to (Reload) or when there
      // are no unsaved edits to lose.
      if (this.pendingReload.delete(msg.path) || !existing.dirty) {
        this.tabContent.set(msg.path, { content: msg.content, readOnly: msg.readOnly });
        this.editorFor(msg.path)?.reload(msg.content);
        this.tabs.setMtime(existing.id, msg.mtimeMs);
        this.tabs.markDirty(existing.id, false);
      }
      this.tabs.activate(existing.id);
    } else if (existing) {
      if (msg.kind === "image") this.tabContent.set(msg.path, { content: msg.content, readOnly: true });
      this.tabs.activate(existing.id);
    } else {
      this.tabContent.set(msg.path, { content: msg.content, readOnly: msg.readOnly });
      this.tabs.open({
        kind: msg.kind === "image" ? "image" : "editor",
        path: msg.path,
        title: ChronosApp.basename(msg.path),
        mtimeMs: msg.mtimeMs,
      });
    }
    if (restoring) {
      // Restoring the saved layout must not steal focus; bring back the saved active tab instead.
      this.tabs.activate(prevActive);
      if (this.restoredActive === msg.path) {
        this.tabs.activate(msg.path);
        this.restoredActive = null;
      }
    }
    this.tabsChanged();
    if (!restoring && msg.kind === "text") void this.updateComplete.then(() => this.editorFor(msg.path)?.focusEditor());
  }

  private saveTab(tab: Tab, force = false): void {
    if (tab.kind !== "editor" || !tab.path) return;
    const editor = this.editorFor(tab.path);
    if (!editor || this.tabContent.get(tab.path)?.readOnly) return;
    const content = editor.getContent();
    this.savingContent.set(tab.path, content);
    this.postMessage({ type: "file/save", path: tab.path, content, expectedMtimeMs: force ? -1 : tab.mtimeMs ?? -1 });
  }

  private onFileSaved(msg: Extract<ExtToWebview, { type: "file/saved" }>): void {
    const tab = this.tabs.tabs.find((t) => t.path === msg.path);
    const content = this.savingContent.get(msg.path);
    this.savingContent.delete(msg.path);
    if (!tab) return;
    if (msg.ok) {
      if (typeof msg.mtimeMs === "number") this.tabs.setMtime(tab.id, msg.mtimeMs);
      const editor = this.editorFor(msg.path);
      if (content !== undefined) {
        this.tabContent.set(msg.path, { content, readOnly: false });
        editor?.setSavedContent(content); // emits dirty-changed if typing continued meanwhile
      }
      // Typing during the round trip leaves the tab dirty against the new baseline.
      if (!editor || content === undefined || editor.getContent() === content) this.tabs.markDirty(tab.id, false);
      if (this.pendingClose.delete(msg.path)) this.tabs.forceClose(tab.id);
      this.tabsChanged();
      return;
    }
    if (msg.error === "changed-on-disk") {
      // A pending close survives into the conflict modal: Overwrite still closes afterwards.
      this.tabs.activate(tab.id);
      this.fileModal = { kind: "conflict", id: tab.id };
      this.tabsChanged();
    } else {
      this.pendingClose.delete(msg.path);
      this.pushToast("error", `Could not save ${tab.title}: ${msg.error ?? "unknown error"}`);
    }
  }

  private requestClose(id: string): void {
    const r = this.tabs.close(id);
    if (r === "needs-confirm") {
      this.tabs.activate(id);
      this.fileModal = { kind: "close", id };
    } else if (r === "closed" && !this.tabs.tabs.some((t) => t.path === id)) {
      this.tabContent.delete(id);
    }
    this.tabsChanged();
  }

  private resolveFileModal(choice: "save" | "discard" | "overwrite" | "reload" | "cancel"): void {
    const modal = this.fileModal;
    this.fileModal = null;
    const tab = modal ? this.tabs.get(modal.id) : undefined;
    if (!modal || !tab?.path) return;
    switch (choice) {
      case "save":
        this.pendingClose.add(tab.path);
        this.saveTab(tab);
        break;
      case "discard":
        this.tabs.forceClose(tab.id);
        this.tabContent.delete(tab.path);
        this.tabsChanged();
        break;
      case "overwrite":
        this.saveTab(tab, true);
        break;
      case "reload":
        this.pendingClose.delete(tab.path);
        this.pendingReload.add(tab.path);
        this.postMessage({ type: "file/open", path: tab.path });
        break;
      case "cancel":
        this.pendingClose.delete(tab.path);
        break;
    }
  }

  private renderFileModal(): TemplateResult {
    const modal = this.fileModal!;
    const tab = this.tabs.get(modal.id);
    const name = tab?.title ?? "";
    const conflict = modal.kind === "conflict";
    return html`
      <div class="dialog-backdrop"></div>
      <div class="dialog file-modal" role="alertdialog" aria-modal="true"
        @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") this.resolveFileModal("cancel"); }}>
        <div class="dialog-title">${conflict ? `${name} changed on disk` : `Save changes to ${name}?`}</div>
        <div class="file-modal-text">
          ${conflict
            ? "The file was modified (perhaps by the agent) after you opened it. Overwrite it with your version, or reload the version on disk and discard your edits?"
            : "Your changes will be lost if you don't save them."}
        </div>
        <div class="dialog-actions">
          <button class="btn-secondary" @click=${() => this.resolveFileModal("cancel")}>Cancel</button>
          ${conflict
            ? html`<button class="btn-secondary" @click=${() => this.resolveFileModal("reload")}>Reload</button>
                <button class="btn-send" @click=${() => this.resolveFileModal("overwrite")}>Overwrite</button>`
            : html`<button class="btn-secondary" @click=${() => this.resolveFileModal("discard")}>Don't save</button>
                <button class="btn-send" @click=${() => this.resolveFileModal("save")}>Save</button>`}
        </div>
      </div>
    `;
  }

  private renderTabContent(tab: Tab): unknown {
    switch (tab.kind) {
      case "page":
        return html`<chronos-page-viewer></chronos-page-viewer>`;
      case "data":
        return html`<chronos-data-viewer></chronos-data-viewer>`;
      case "image":
        return html`<chronos-image-tab .src=${this.tabContent.get(tab.path!)?.content ?? ""}></chronos-image-tab>`;
      case "editor": {
        const c = this.tabContent.get(tab.path!);
        return html`<chronos-code-editor
          .path=${tab.path!}
          .content=${c?.content ?? ""}
          .readOnly=${c?.readOnly ?? false}
          @dirty-changed=${(e: CustomEvent<{ dirty: boolean }>) => {
            this.tabs.markDirty(tab.id, e.detail.dirty);
            this.tabsRev++;
          }}
          @save-requested=${() => this.saveTab(tab)}
        ></chronos-code-editor>`;
      }
    }
  }

  private readonly onGlobalKeydown = (e: KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
      const active = this.tabs.active;
      if (active.kind !== "editor" && active.kind !== "image") return;
      if (this.fileModal || this.uiRequest) return;
      e.preventDefault();
      this.requestClose(active.id);
    }
  };

  protected updated(changed: Map<string, unknown>): void {
    // Focus the modal's primary action so Enter / Escape work without a click.
    if (changed.has("fileModal") && this.fileModal) this.querySelector<HTMLButtonElement>(".file-modal .btn-send")?.focus();
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onGlobalKeydown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onGlobalKeydown);
  }

  // ── splitter ──────────────────────────────────────────────────────────────

  private openHistoryDrawer(): void {
    this.postMessage({ type: "refreshSessions" });
    this.drawerOpen = true;
  }

  private submitShowPage(): void {
    const p = this.showPagePrompt;
    this.showPagePrompt = null;
    const pageId = Math.floor(Number(p?.page));
    if (!p?.source || !Number.isFinite(pageId) || pageId < 1) return;
    this.postMessage({ type: "showPageRequest", sourceName: p.source, pageId });
  }

  private renderShowPagePrompt(): TemplateResult {
    const p = this.showPagePrompt!;
    return html`
      <div class="dialog-backdrop" @click=${() => (this.showPagePrompt = null)}></div>
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="dialog-title">Show page</div>
        <select class="dialog-input" id="showpage-source" @change=${(e: Event) => (this.showPagePrompt = { ...p, source: (e.target as HTMLSelectElement).value })}>
          ${this.sources.map((s) => html`<option value=${s.name} ?selected=${s.name === p.source}>${s.name} (${s.pageCount} pages)</option>`)}
        </select>
        <input class="dialog-input" id="showpage-page" type="number" min="1" .value=${p.page} placeholder="Page number"
          @input=${(e: Event) => (this.showPagePrompt = { ...p, page: (e.target as HTMLInputElement).value })}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") this.submitShowPage(); if (e.key === "Escape") this.showPagePrompt = null; }} />
        <div class="dialog-actions">
          <button class="btn-secondary" @click=${() => (this.showPagePrompt = null)}>Cancel</button>
          <button class="btn-send" @click=${() => this.submitShowPage()}>OK</button>
        </div>
      </div>
    `;
  }

  private onTreeSplitterDown(e: PointerEvent): void {
    e.preventDefault();
    const pane = this.querySelector<HTMLElement>("#pane-tree");
    if (!pane) return;
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const left = pane.getBoundingClientRect().left;
    const onMove = (ev: PointerEvent) => {
      this.treeWidth = ChronosApp.clampTree(ev.clientX - left);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("lostpointercapture", onUp);
      this.dispatchEvent(new CustomEvent("ui-state-changed", { bubbles: true }));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("lostpointercapture", onUp);
  }

  private onSplitterDown(e: PointerEvent): void {
    e.preventDefault();
    // splitPct is the viewer's share of the viewer+chat area (excludes the tree pane).
    const root = this.querySelector<HTMLElement>("#app-panes");
    if (!root) return;
    // Capture on the splitter so a pointerup released outside the webview still
    // tears the listeners down (a missed window pointerup would leak onMove).
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      this.splitPct = Math.max(25, Math.min(75, ((ev.clientX - rect.left) / rect.width) * 100));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("lostpointercapture", onUp);
      this.dispatchEvent(new CustomEvent("ui-state-changed", { bubbles: true }));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("lostpointercapture", onUp); // also covers pointercancel
  }

  // ── render ────────────────────────────────────────────────────────────────

  render(): TemplateResult {
    return html`
      <div id="app-root" @keydown=${(e: KeyboardEvent) => { if (this.tabs.activeId === "page") this.viewer?.handleKeydown(e); }}>
        ${this.renderHeader()}
        ${this.progress.size ? this.renderProgress() : nothing}
        ${this.loginRequired ? this.renderLoginBanner() : nothing}
        <div id="app-main">
          <div id="pane-tree" ?hidden=${this.treeHidden} style="flex-basis:${this.treeWidth}px">
            <chronos-file-tree .currentSource=${this.currentSource}></chronos-file-tree>
          </div>
          ${this.treeHidden ? nothing : html`<div id="splitter-tree" @pointerdown=${this.onTreeSplitterDown} title="Drag to resize"></div>`}
          <div id="app-panes">
          <div id="pane-viewer" style="flex-basis:${this.chatHidden ? 100 : this.splitPct}%">
            <chronos-center-tabs
              .tabs=${[...this.tabs.tabs]}
              .activeId=${this.tabs.activeId}
              .renderTab=${(t: Tab) => this.renderTabContent(t)}
              @tab-activate=${(e: CustomEvent<{ id: string }>) => this.activateTab(e.detail.id)}
              @tab-close=${(e: CustomEvent<{ id: string }>) => this.requestClose(e.detail.id)}
            ></chronos-center-tabs>
          </div>
          ${this.chatHidden ? nothing : html`<div id="splitter" @pointerdown=${this.onSplitterDown} title="Drag to resize"></div>`}
          <div id="pane-chat" ?hidden=${this.chatHidden} style="flex-basis:${100 - this.splitPct}%">
            <chronos-chat></chronos-chat>
          </div>
          </div>
        </div>
        ${this.drawerOpen ? this.renderDrawer() : nothing}
        ${this.uiRequest ? this.renderUiRequest() : nothing}
        ${this.fileModal ? this.renderFileModal() : nothing}
        ${this.showPagePrompt ? this.renderShowPagePrompt() : nothing}
        ${this.loginProviders
          ? html`<chronos-provider-dialog
              .providers=${this.loginProviders}
              .oauthStatus=${this.oauthStatus}
              .post=${(m: WebviewToExt) => this.postMessage(m)}
              @close=${() => {
                this.loginProviders = null;
                this.oauthStatus = null;
              }}
            ></chronos-provider-dialog>`
          : nothing}
        ${this.sessionLoading ? this.renderSessionLoading() : nothing}
        ${this.toasts.length ? this.renderToasts() : nothing}
      </div>
    `;
  }

  private renderHeader(): TemplateResult {
    const model = this.state?.model;
    return html`
      <header id="app-header">
        <div class="brand">
          <img class="brand-mark" src=${brandIcon} width="18" height="18" alt="" aria-hidden="true" />
          <span class="brand-name">Chronos</span>
        </div>
        <div class="header-controls">
          <label class="control">
            <span class="control-label">Source</span>
            <select
              class="control-select"
              .value=${this.currentSource}
              @change=${(e: Event) => {
                const name = (e.target as HTMLSelectElement).value;
                if (name) this.postMessage({ type: "selectSource", name });
              }}
            >
              <option value="" ?selected=${!this.currentSource}>— none —</option>
              ${this.sources.map(
                (s) => html`<option value=${s.name} ?selected=${s.name === this.currentSource || s.name.endsWith("/" + this.currentSource)}>
                  ${s.name} (${s.pageCount} pp.)
                </option>`,
              )}
            </select>
          </label>
          <label class="control">
            <span class="control-label">Model</span>
            <select
              class="control-select"
              @change=${(e: Event) => {
                const value = (e.target as HTMLSelectElement).value;
                const [provider, ...rest] = value.split("/");
                if (provider && rest.length) {
                  this.postMessage({ type: "setModel", provider, modelId: rest.join("/") });
                }
              }}
            >
              ${!model
                ? html`<option selected disabled>${this.loginRequired ? "— log in —" : "loading…"}</option>`
                : nothing}
              ${this.models.map((m) => {
                const id = `${m.provider}/${m.id}`;
                const current = model ? `${model.provider}/${model.id}` === id : false;
                return html`<option value=${id} ?selected=${current}>${id}</option>`;
              })}
            </select>
          </label>
          ${this.renderContextMeter()}
          <button
            class="header-btn login-btn ${this.loginRequired ? "is-attn" : ""}"
            title="Connect an AI provider (Claude subscription sign-in, or an API key)"
            @click=${() => this.postMessage({ type: "login" })}
          >
            Log in
          </button>
          <button
            class="header-btn yolo-toggle ${this.yolo ? "is-on" : ""}"
            title=${this.yolo
              ? "Auto-approve is ON — commands run without asking"
              : "Auto-approve is OFF — commands ask for permission"}
            @click=${() => this.postMessage({ type: "setYolo", enabled: !this.yolo })}
          >
            <span class="yolo-dot"></span>Auto-approve
          </button>
          <button class="header-btn" title="Past sessions" @click=${() => this.openHistoryDrawer()}>History</button>
          <button class="header-btn" title="Start a fresh session" @click=${() => this.postMessage({ type: "newSession" })}>New</button>
        </div>
      </header>
    `;
  }

  // ── progress (host tasks such as source import) ───────────────────────────

  private updateProgress(p: ProgressEntry): void {
    const { id, title, done, total, message, finished } = p;
    const next = new Map(this.progress);
    next.set(id, { id, title, done, total, message, finished });
    this.progress = next;
    if (finished) {
      // Keep the completed bar visible briefly before dropping it.
      setTimeout(() => {
        if (!this.progress.get(id)?.finished) return;
        const rest = new Map(this.progress);
        rest.delete(id);
        this.progress = rest;
      }, 1500);
    }
  }

  private renderProgress(): TemplateResult {
    return html`${[...this.progress.values()].map((p) => {
      const pct = p.total ? Math.max(0, Math.min(100, (p.done / p.total) * 100)) : undefined;
      const count = p.total ? `${p.done}/${p.total}` : "";
      return html`
        <div class="progress-row ${p.finished ? "is-finished" : ""}" role="progressbar"
          aria-label=${p.title}
          aria-valuemin="0"
          aria-valuemax=${p.total ?? nothing}
          aria-valuenow=${p.total ? p.done : nothing}>
          <div class="progress-text">
            <span class="progress-title">${p.title}</span>
            ${p.message ? html`<span class="progress-message">${p.message}</span>` : nothing}
            ${count ? html`<span class="progress-count">${count}</span>` : nothing}
          </div>
          <div class="progress-track">
            <div class="progress-fill ${pct === undefined ? "is-indeterminate" : ""}" style="width:${pct ?? 100}%"></div>
          </div>
        </div>
      `;
    })}`;
  }

  private renderLoginBanner(): TemplateResult {
    return html`
      <div class="login-banner">
        <span class="login-banner-text">
          <strong>No AI models available.</strong>
          Connect a provider to get started — sign in with your Claude subscription, or add an API key.
        </span>
        <button class="login-banner-btn" @click=${() => this.postMessage({ type: "login" })}>
          Connect provider
        </button>
      </div>
    `;
  }

  private renderContextMeter(): TemplateResult | typeof nothing {
    const window = this.state?.model?.contextWindow;
    if (!window || !this.contextTokens) return nothing;
    const pct = Math.min(100, Math.round((this.contextTokens / window) * 100));
    const level = pct >= 90 ? "is-critical" : pct >= 70 ? "is-high" : "";
    // SVG ring: r=5.5 → circumference ≈ 34.56
    const circumference = 34.56;
    const offset = circumference * (1 - pct / 100);
    const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    return html`
      <div
        class="ctx-meter ${level}"
        title="Context window: ${this.contextTokens.toLocaleString()} of ${window.toLocaleString()} tokens used (${pct}%)${pct >= 70 ? " — pi will compact automatically when full" : ""}"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="2" opacity="0.18"/>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" transform="rotate(-90 7 7)"
            stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/>
        </svg>
        <span class="ctx-meter-label">${fmt(this.contextTokens)} · ${pct}%</span>
      </div>
    `;
  }

  private renderDrawer(): TemplateResult {
    const fmt = (ts: number) =>
      new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    return html`
      <div class="drawer-backdrop" @click=${() => (this.drawerOpen = false)}></div>
      <aside class="drawer">
        <div class="drawer-header">
          <span class="drawer-title">Sessions</span>
          <button class="icon-btn" title="Close" @click=${() => (this.drawerOpen = false)}>✕</button>
        </div>
        <div class="drawer-list">
          ${this.sessions.length === 0 ? html`<div class="drawer-empty">No past sessions in this workspace.</div>` : nothing}
          ${this.sessions.map(
            (s) => html`
              <button
                class="session-row ${s.path === this.state?.sessionFile ? "is-current" : ""}"
                @click=${() => {
                  this.drawerOpen = false;
                  if (s.path !== this.state?.sessionFile) {
                    this.sessionLoading = { name: s.name, sizeBytes: s.sizeBytes };
                    this.postMessage({ type: "resumeSession", sessionPath: s.path });
                  }
                }}
              >
                <span class="session-name">${s.name}</span>
                <span class="session-meta">${fmt(s.timestamp)} · ${s.messageCount} messages</span>
              </button>
            `,
          )}
        </div>
      </aside>
    `;
  }

  private renderUiRequest(): TemplateResult {
    const req = this.uiRequest!;
    let body: TemplateResult = html``;
    switch (req.method) {
      case "select":
        body = html`
          <div class="dialog-options">
            ${req.options.map(
              (opt) => html`<button class="dialog-option" @click=${() => this.answerUiRequest({ value: opt })}>${opt}</button>`,
            )}
          </div>
        `;
        break;
      case "confirm":
        body = html`
          <div class="dialog-message">${req.message}</div>
          <div class="dialog-actions">
            <button class="btn-secondary" @click=${() => this.answerUiRequest({ confirmed: false })}>Deny</button>
            <button class="btn-send" @click=${() => this.answerUiRequest({ confirmed: true })}>Allow</button>
          </div>
        `;
        break;
      case "input":
      case "editor": {
        const isEditor = req.method === "editor";
        body = html`
          ${isEditor
            ? html`<textarea id="dialog-input" class="dialog-textarea" rows="8">${(req as any).prefill ?? ""}</textarea>`
            : html`<input id="dialog-input" class="dialog-input" placeholder=${(req as any).placeholder ?? ""} @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") {
                  this.answerUiRequest({ value: (e.target as HTMLInputElement).value });
                }
              }} />`}
          <div class="dialog-actions">
            <button class="btn-secondary" @click=${() => this.answerUiRequest({ cancelled: true })}>Cancel</button>
            <button class="btn-send" @click=${() => {
              const el = this.querySelector<HTMLInputElement | HTMLTextAreaElement>("#dialog-input");
              this.answerUiRequest({ value: el?.value ?? "" });
            }}>OK</button>
          </div>
        `;
        break;
      }
      default:
        body = html`<div class="dialog-actions"><button class="btn-secondary" @click=${() => this.answerUiRequest({ cancelled: true })}>Dismiss</button></div>`;
    }
    return html`
      <div class="dialog-backdrop"></div>
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="dialog-title">${"title" in req ? req.title : "Chronos"}</div>
        ${body}
        ${req.method === "select"
          ? html`<div class="dialog-actions"><button class="btn-secondary" @click=${() => this.answerUiRequest({ cancelled: true })}>Cancel</button></div>`
          : nothing}
      </div>
    `;
  }

  private renderSessionLoading(): TemplateResult {
    const loading = this.sessionLoading!;
    const sizeMb = loading.sizeBytes ? loading.sizeBytes / (1024 * 1024) : 0;
    const isBig = sizeMb >= 5;
    return html`
      <div class="dialog-backdrop"></div>
      <div class="session-loading" role="status">
        <span class="spinner spinner-lg"></span>
        <div class="session-loading-title">${loading.title ?? "Opening session"}</div>
        <div class="session-loading-name">${loading.name}</div>
        ${isBig
          ? html`<div class="session-loading-hint">
              Large session (${sizeMb.toFixed(0)} MB) — rebuilding the agent's context can take a few seconds.
            </div>`
          : nothing}
      </div>
    `;
  }

  private renderToasts(): TemplateResult {
    return html`
      <div class="toasts">
        ${this.toasts.map((t) => html`<div class="toast toast-${t.level}">${t.message}</div>`)}
      </div>
    `;
  }

  protected firstUpdated(): void {
    this.chat?.setPostMessage((msg) => this.postMessage(msg));
    // The viewers live inside <chronos-center-tabs>, which renders in its own update.
    void this.querySelector("chronos-center-tabs")?.updateComplete.then(() => {
      this.viewer?.setPostMessage((msg) => this.postMessage(msg));
      this.dataViewer?.setPostMessage((msg) => this.postMessage(msg));
    });
    if (this.tabs.activeId === "data") this.postMessage({ type: "data/listRequest" });
    if (this.restoringPaths.size) {
      for (const path of this.restoringPaths.keys()) this.postMessage({ type: "file/open", path });
      // Paths main refused (deleted / moved meanwhile) never answer; stop persisting them.
      setTimeout(() => {
        this.restoringPaths.clear();
        this.restoredActive = null;
      }, 5000);
    }
    const tree = this.tree;
    if (tree) {
      tree.setPostMessage((msg) => this.postMessage(msg));
      if (this.restoredExpanded.length) tree.restoreExpanded(this.restoredExpanded);
    }
    this.addEventListener("rewind-start", (e) => {
      const preview = (e as CustomEvent).detail?.preview ?? "";
      this.sessionLoading = {
        title: "Rewinding conversation",
        name: preview.length > 60 ? preview.slice(0, 60) + "…" : preview,
      };
    });
  }
}

customElements.define("chronos-app", ChronosApp);

declare global {
  interface HTMLElementTagNameMap {
    "chronos-app": ChronosApp;
  }
}
