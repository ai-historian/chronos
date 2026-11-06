import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveTheme, themeCss, type ThemeName } from "./theme";
import { WindowTransport } from "./window-transport";
import { AgentHost } from "./agent-host";
import { TreeHost } from "./tree-host";
import { buildPiLaunch, type PiLaunch } from "./pi-launcher";
import { resolveVendorPaths, unpackedPath } from "./paths";
import { registerChronosFileScheme, installChronosFileHandler, toChronosFileUrl } from "./protocol-handler";
import { providerChoices, saveApiKey, startAnthropicOauth, submitAnthropicOauthCode, cancelAnthropicOauth } from "./login";
import { RecentStore, ensureWorkspace, pickFolderToCreate, pickWorkspaceToOpen } from "./workspace";
import { appLogPath, installAppLog } from "./app-log";
import { buildMenu, type MenuActions, type MenuState } from "./menu";
import { readAppSettings, writeAppSettings } from "./app-settings";
import {
  findIncompleteImports,
  importFiles,
  importFolder,
  resumeIncompleteImports,
  type ImportResult,
  type ProgressSink,
} from "./import/import";
import { readImportMarker } from "./import/import-status";
import type { ExtToWebview, WebviewToExt, WelcomeToExt } from "../shared/webview-protocol";

function workspaceFromArgv(argv: string[]): string | undefined {
  const i = argv.indexOf("--workspace");
  const dir = i >= 0 ? argv[i + 1] : undefined;
  return dir ? resolve(dir) : undefined;
}

/**
 * TEST-ONLY: CHRONOS_PI_LAUNCH_OVERRIDE (JSON `{ bin, args, env? }`) replaces the bundled pi
 * launch — the e2e suite points it at test/mock-pi.mjs. CHRONOS_HTTP_PORT is merged in.
 */
function launchOverride(port: number): PiLaunch | undefined {
  const raw = process.env.CHRONOS_PI_LAUNCH_OVERRIDE;
  if (!raw) return undefined;
  const o = JSON.parse(raw) as { bin: string; args: string[]; env?: Record<string, string> };
  return { bin: o.bin, args: o.args, env: { ...(o.env ?? {}), CHRONOS_HTTP_PORT: String(port) } };
}

// Start the app log (Help ▸ Show logs) before anything else logs.
function startAppLog(): void {
  try {
    installAppLog(app.getPath("logs"));
  } catch (e) {
    console.error("[chronos] could not open the app log:", e);
  }
}
startAppLog();

// Must run before app is ready.
registerChronosFileScheme();

// Workspace the chronos-file:// handler is scoped to.
let currentWorkspace: string | undefined;
let mainWindow: BrowserWindow | undefined;
let welcomeWindow: BrowserWindow | undefined;
let quitting = false;
/**
 * What happens once the main window has closed. Set when we initiate the close; the window's
 * renderer may cancel it (beforeunload with unsaved editor tabs) and later re-request it with
 * window/close, so the intent is kept until the window is actually gone.
 */
type AfterClose = { kind: "welcome" } | { kind: "open"; path: string } | { kind: "quit" };
let mainAfterClose: AfterClose = { kind: "welcome" };
/** The next main-window `close` event is one we started (keep mainAfterClose). */
let mainOwnClose = false;

function closeMainWindow(after: AfterClose): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainAfterClose = after;
  mainOwnClose = true;
  mainWindow.close();
}
let recent: RecentStore;
let themePref: "system" | ThemeName = "system";
// Live main-window host and its last reported state, for the application menu.
let activeHost: AgentHost | undefined;
let hostState: Pick<MenuState, "models" | "currentModel" | "thinking" | "yolo"> = { models: [], thinking: "off", yolo: false };

function webPrefs(): Electron.WebPreferences {
  return { preload: join(__dirname, "preload.js"), contextIsolation: true, sandbox: false };
}

function sendTheme(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  const name = resolveTheme(themePref, nativeTheme.shouldUseDarkColors);
  win.webContents.send("chronos:msg", { type: "theme", name, css: themeCss(name) });
}

function createWelcomeWindow(): void {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 640,
    height: 480,
    resizable: false,
    title: "Chronos",
    webPreferences: webPrefs(),
  });
  welcomeWindow = win;
  win.setMenuBarVisibility(false);
  const theme = () => sendTheme(win);
  win.webContents.on("did-finish-load", () => {
    theme();
    if (!win.isDestroyed()) win.webContents.send("chronos:msg", { type: "workspace/recent", items: recent.list() });
  });
  nativeTheme.on("updated", theme);
  const onMsg = (e: Electron.IpcMainEvent, msg: WelcomeToExt) => {
    if (e.sender !== win.webContents) return;
    void handleWelcomeMessage(win, msg);
  };
  ipcMain.on("chronos:msg", onMsg);
  win.on("closed", () => {
    nativeTheme.off("updated", theme);
    ipcMain.off("chronos:msg", onMsg);
    if (welcomeWindow === win) welcomeWindow = undefined;
  });
  void win.loadFile(join(__dirname, "renderer", "welcome.html"));
}

async function handleWelcomeMessage(win: BrowserWindow, msg: WelcomeToExt): Promise<void> {
  let path: string | null = null;
  if (msg.type === "workspace/open") path = await pickWorkspaceToOpen(win);
  else if (msg.type === "workspace/create") path = await pickFolderToCreate(win);
  else if (msg.type === "workspace/openRecent") {
    // The renderer may only name a path we offered it; anything else is ignored silently.
    const wanted = typeof msg.path === "string" ? resolve(msg.path) : "";
    path = recent.list().some((i) => resolve(i.path) === wanted) ? wanted : null;
  }
  if (path && !win.isDestroyed()) await openOrOfferInit(path, win);
}

/**
 * The one way to open a workspace from a path: it must be a directory, and if it is not a Chronos
 * workspace yet the user is offered to initialise it (Cancel opens nothing). `replace` swaps out
 * an already-open main window (menu); otherwise an open main window is just focused.
 */
async function openOrOfferInit(path: string, parent: BrowserWindow | null, replace = false): Promise<void> {
  const dir = resolve(path);
  if (!isDirectory(dir)) {
    const opts: Electron.MessageBoxOptions = { type: "error", message: "Folder not found", detail: dir, buttons: ["OK"] };
    if (parent && !parent.isDestroyed()) await dialog.showMessageBox(parent, opts);
    else await dialog.showMessageBox(opts);
    return;
  }
  if (!(await ensureWorkspace(dir, parent && !parent.isDestroyed() ? parent : null))) return;
  openMainWindow(dir, replace);
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Create the main window for a workspace, replacing the welcome window. */
function openMainWindow(workspaceDir: string, replace = false): void {
  workspaceDir = resolve(workspaceDir);
  const old = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  if (old && !replace) {
    old.focus();
    return;
  }
  if (old) {
    // Swapping workspaces: close the old window first (it may refuse: unsaved edits → its renderer
    // asks the user); the new one opens from the old one's `closed` event.
    closeMainWindow({ kind: "open", path: workspaceDir });
    return;
  }
  currentWorkspace = workspaceDir;
  recent.add(workspaceDir);
  const win = createMainWindow(workspaceDir);
  mainWindow = win;
  // Close welcome only after the main window exists so window-all-closed never fires.
  if (welcomeWindow && !welcomeWindow.isDestroyed()) welcomeWindow.close();
}

function createMainWindow(workspaceDir: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Chronos",
    webPreferences: webPrefs(),
  });
  const transport = new WindowTransport(win);
  const theme = () => sendTheme(win);
  win.webContents.on("did-finish-load", theme);
  nativeTheme.on("updated", theme);

  let host: AgentHost | undefined;
  const tree = new TreeHost({
    root: workspaceDir,
    transport,
    showPage: (sourceName, pageId) => host?.showPageById(sourceName, pageId),
    imageUri: toChronosFileUrl,
  });
  const onMsg = (e: Electron.IpcMainEvent, msg: WebviewToExt) => {
    if (e.sender !== win.webContents) return;
    if (msg.type === "window/close") {
      // The renderer resolved its unsaved edits; beforeunload now passes. Keep the pending intent.
      mainOwnClose = true;
      win.close();
      return;
    }
    // File-tree / file messages first; everything else is the agent host's.
    if (tree.handle(msg)) return;
    void host?.handleWebviewMessage(msg);
  };
  ipcMain.on("chronos:msg", onMsg);

  host = new AgentHost({
    workspaceDir,
    transport,
    launch: (port) =>
      launchOverride(port) ??
      buildPiLaunch({
        vendor: resolveVendorPaths({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appRoot: app.getAppPath(),
        }),
        workspaceDir,
        userDataDir: app.getPath("userData"),
        httpPort: port,
        execPath: process.execPath,
      }),
    imageUri: toChronosFileUrl,
    onTitle: (t) => {
      if (!win.isDestroyed()) win.setTitle(t);
    },
    loginProviders: providerChoices,
    onLogin: {
      apiKey: async (envVar, key) => {
        saveApiKey(workspaceDir, envVar, key);
        transport.post({ type: "notify", level: "info", message: `Saved ${envVar}. Restarting agent…` });
        await host?.restart();
      },
      oauthStart: async () => {
        try {
          await startAnthropicOauth({
            // pi's agent dir (PI_CODING_AGENT_DIR, see pi-launcher) — never ~/.pi.
            authDir: join(app.getPath("userData"), "pi-agent"),
            openExternal: (url) => shell.openExternal(url),
            onStatus: (s) => transport.post({ type: "login/oauthStatus", ...s }),
          });
        } catch {
          return; // already reported to the dialog via login/oauthStatus
        }
        await host?.restart();
      },
      oauthCode: submitAnthropicOauthCode,
      cancel: cancelAnthropicOauth,
    },
    onImport: () => void importSources(),
    // The agent is blocked on the user (permission card / dialog): get their attention.
    onAttention: () => {
      if (win.isDestroyed() || win.isFocused()) return;
      win.flashFrame(true);
      app.dock?.bounce?.("informational");
    },
  });
  const h = host;
  activeHost = h;
  // TEST-ONLY (CHRONOS_E2E=1): lets the e2e suite read the agent's pid via electronApp.evaluate.
  if (process.env.CHRONOS_E2E === "1") (globalThis as any).__chronosE2E = { agentPid: () => activeHost?.agentPid };
  hostState = { models: [], thinking: "off", yolo: false };
  const unsubscribe = h.onStateChange((st) => {
    hostState = st;
    rebuildMenu();
  });
  rebuildMenu();
  // Every (re)load gets a fresh root listing; the watcher dedupes already-watched dirs.
  win.webContents.on("did-finish-load", () => tree.start());
  win.webContents.once("did-finish-load", () => {
    void h.start();
    void promptRecoverIncompleteImports(win, h, workspaceDir);
  });

  win.on("focus", () => {
    if (!win.isDestroyed()) win.flashFrame(false);
  });
  win.on("close", () => {
    if (mainWindow !== win) return;
    // A close we did not start (title-bar ✕) means "back to welcome", unless the app is quitting.
    if (!mainOwnClose && !quitting) mainAfterClose = { kind: "welcome" };
    mainOwnClose = false;
  });
  // The renderer's beforeunload cancelled the close (unsaved edits): a quit in progress is aborted.
  win.webContents.on("will-prevent-unload", () => {
    quitting = false;
  });
  win.on("closed", () => {
    const after: AfterClose = mainWindow === win ? mainAfterClose : { kind: "welcome" };
    if (mainWindow === win) mainAfterClose = { kind: "welcome" };
    nativeTheme.off("updated", theme);
    ipcMain.off("chronos:msg", onMsg);
    cancelAnthropicOauth();
    unsubscribe();
    tree.stop();
    void host?.stop();
    if (activeHost === h) activeHost = undefined;
    if (mainWindow === win) {
      mainWindow = undefined;
      currentWorkspace = undefined;
    }
    rebuildMenu();
    if (quitting || mainWindow) return;
    if (after.kind === "open") openMainWindow(after.path);
    else if (after.kind === "welcome") createWelcomeWindow();
    // "quit": resume the quit the renderer paused. Explicit, because on macOS window-all-closed
    // does not quit.
    else app.quit();
  });
  // Dev aid: CHRONOS_DEV_PROTOCOL_CHECK=1 loads an in-workspace PNG (expect loaded) and an outside file (expect blocked, i.e. 403) via <img>, since the renderer CSP forbids fetch().
  if (process.env.CHRONOS_DEV_PROTOCOL_CHECK === "1") {
    win.webContents.once("did-finish-load", () => {
      const inside = toChronosFileUrl(join(workspaceDir, "sources", "Demo", "png", "page_0001.png"));
      const outside = toChronosFileUrl(app.getAppPath() + "/package.json");
      for (const [label, url] of [["inside", inside], ["outside", outside]] as const) {
        void win.webContents
          .executeJavaScript(`new Promise(res=>{const i=new Image();i.onload=()=>res("loaded "+i.naturalWidth+"x"+i.naturalHeight);i.onerror=()=>res("blocked/error");i.src=${JSON.stringify(url)}})`)
          .then((st) => console.log(`[chronos] protocol-check ${label}: ${st}`))
          .catch((e) => console.log(`[chronos] protocol-check ${label}: error ${e}`));
      }
    });
  }
  void win.loadFile(join(__dirname, "renderer", "index.html"));
  return win;
}

// ── application menu ────────────────────────────────────────────────────────

function sendToMain(msg: ExtToWebview): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("chronos:msg", msg);
}

function hostMsg(msg: WebviewToExt): void {
  void activeHost?.handleWebviewMessage(msg);
}

function setThemePref(t: "system" | ThemeName): void {
  themePref = t;
  try {
    writeAppSettings(app.getPath("userData"), { theme: t });
  } catch (e) {
    console.error("[chronos] could not save settings:", e);
  }
  for (const w of BrowserWindow.getAllWindows()) sendTheme(w);
  rebuildMenu();
}

// ── source import ───────────────────────────────────────────────────────────

let importRunning = false;

function importWorkers(): { pdf: string; split: string } {
  // Packaged: main.js is inside app.asar, the workers are asarUnpack'ed beside it.
  const at = (f: string) => (app.isPackaged ? unpackedPath(join(__dirname, f)) : join(__dirname, f));
  return { pdf: at("pdf-worker.js"), split: at("pdf-split-worker.js") };
}

/** Progress events go to the window the import started in (not whichever is main later). */
function progressTo(transport: WindowTransport): ProgressSink {
  return (p) => transport.post({ type: "progress", ...p });
}

/** Run one import job with the single-import guard; returns undefined if another is running. */
async function runImportJob(transport: WindowTransport, job: () => Promise<ImportResult>): Promise<ImportResult | undefined> {
  if (importRunning) {
    transport.post({ type: "notify", level: "warning", message: "An import is already running" });
    return undefined;
  }
  importRunning = true;
  try {
    return await job();
  } catch (e) {
    transport.post({ type: "notify", level: "error", message: `Chronos Import failed: ${(e as Error).message}` });
    return undefined;
  } finally {
    importRunning = false;
  }
}

async function importSources(): Promise<void> {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const host = activeHost;
  const workspace = currentWorkspace;
  if (!win || !host || !workspace) return;
  const transport = new WindowTransport(win);
  if (importRunning) {
    transport.post({ type: "notify", level: "warning", message: "An import is already running" });
    return;
  }

  const { response } = await dialog.showMessageBox(win, {
    message: "Import sources",
    detail: "Import individual files, or every supported file in a folder?",
    buttons: ["Files…", "Folder…", "Cancel"],
    cancelId: 2,
  });
  if (response === 2) return;
  const folderMode = response === 1;
  const picked = await dialog.showOpenDialog(
    win,
    folderMode
      ? { properties: ["openDirectory"] }
      : {
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "Documents", extensions: ["pdf", "png", "jpg", "jpeg", "tif", "tiff", "txt"] }],
        },
  );
  if (picked.canceled || picked.filePaths.length === 0) return;

  const sourcesDir = join(workspace, "sources");
  const progress = progressTo(transport);
  const result = await runImportJob(transport, () =>
    folderMode
      ? importFolder(picked.filePaths[0], sourcesDir, importWorkers(), progress)
      : importFiles(picked.filePaths, sourcesDir, importWorkers(), progress),
  );
  if (!result) return;
  host.refreshSources();

  const total = result.imported + result.skipped.length + result.errors.length;
  if (folderMode && total === 0) {
    transport.post({
      type: "notify",
      level: "warning",
      message: "Chronos: No supported files found in that folder (pdf, txt, png, jpg, jpeg, tif, tiff, bmp).",
    });
    return;
  }
  const parts: string[] = [];
  if (result.imported > 0) parts.push(`${result.imported} imported`);
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped (already exist or unsupported)`);
  if (result.errors.length > 0) parts.push(`${result.errors.length} errors`);
  const summary = parts.join(", ");
  if (result.errors.length > 0) {
    transport.post({ type: "notify", level: "warning", message: `Chronos Import: ${summary}. Errors: ${result.errors.join("; ")}` });
  } else {
    transport.post({ type: "notify", level: "info", message: `Chronos Import: ${summary}.` });
  }
}

// If any imports were interrupted (markers left behind), tell the user and offer to resume or
// discard. Called when a workspace window opens so failures are never silent.
async function promptRecoverIncompleteImports(win: BrowserWindow, host: AgentHost, workspace: string): Promise<void> {
  const sourcesDir = join(workspace, "sources");
  const incompletes = findIncompleteImports(sourcesDir);
  if (incompletes.length === 0 || win.isDestroyed()) return;
  const transport = new WindowTransport(win);
  // An import keeps running in the main process when its window closes, so a reopened
  // workspace can see that import's live marker. Never offer to resume/discard it.
  if (importRunning) {
    transport.post({ type: "notify", level: "info", message: "An import is still running; recovery will be offered next time" });
    return;
  }

  const detail = incompletes
    .map((i) => {
      const pages = i.marker.expectedPages ? `${i.renderedPages}/${i.marker.expectedPages}` : `${i.renderedPages}`;
      return `${i.name} (${pages} pages${i.marker.lastError ? `; ${i.marker.lastError}` : ""})`;
    })
    .join(", ");
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    message: `Chronos: ${incompletes.length} source import(s) were interrupted and are incomplete: ${detail}. Resume now, or discard the partial data?`,
    buttons: ["Resume", "Discard", "Later"],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) {
    const result = await runImportJob(transport, () =>
      resumeIncompleteImports(incompletes, sourcesDir, importWorkers(), progressTo(transport)),
    );
    if (!result) return;
    host.refreshSources();
    const summary = [result.imported ? `${result.imported} completed` : "", result.errors.length ? `${result.errors.length} failed` : ""]
      .filter(Boolean)
      .join(", ");
    if (result.errors.length) {
      transport.post({ type: "notify", level: "warning", message: `Chronos: Resume — ${summary || "nothing to do"}. ${result.errors.join("; ")}` });
    } else {
      transport.post({ type: "notify", level: "info", message: `Chronos: Resume — ${summary || "nothing to do"}.` });
    }
  } else if (response === 1) {
    if (importRunning) {
      transport.post({ type: "notify", level: "warning", message: "An import is already running; nothing was discarded" });
      return;
    }
    let discarded = 0;
    for (const i of incompletes) {
      // Re-check right before deleting: a source that completed meanwhile (has png/) or whose
      // marker is gone is no longer an incomplete import and must never be discarded.
      if (existsSync(join(i.sourceDir, "png")) || !readImportMarker(i.sourceDir)) continue;
      rmSync(i.sourceDir, { recursive: true, force: true });
      discarded++;
    }
    transport.post({ type: "notify", level: "info", message: `Chronos: discarded ${discarded} incomplete import(s).` });
  }
}

function closeWorkspace(): void {
  closeMainWindow({ kind: "welcome" });
}

async function newWorkspaceFromMenu(): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow();
  const path = await pickFolderToCreate(parent);
  if (path) openWorkspaceFromMenu(path);
}

async function openWorkspaceFromMenu(path?: string): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow();
  const target = path ?? (await pickWorkspaceToOpen(parent));
  if (!target) return;
  await openOrOfferInit(target, parent, true);
}

function agentVersion(): string {
  try {
    const dir = resolveVendorPaths({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot: app.getAppPath() }).agentDir;
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function piVersion(): string {
  try {
    return JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf-8")).piVersion ?? "unknown";
  } catch {
    return "unknown";
  }
}

function aboutText(): string {
  return [
    `Chronos ${app.getVersion()}`,
    `Agent ${agentVersion()}`,
    `pi ${piVersion()}`,
    `Electron ${process.versions.electron}`,
    `Node ${process.versions.node}`,
  ].join("\n");
}

function showLogs(): void {
  const file = appLogPath();
  if (file) {
    shell.showItemInFolder(file);
    return;
  }
  const dir = app.getPath("logs");
  mkdirSync(dir, { recursive: true });
  void shell.openPath(dir);
}

function menuActions(): MenuActions {
  const open = (url: string) => () => void shell.openExternal(url);
  return {
    newWorkspace: () => void newWorkspaceFromMenu(),
    openWorkspace: () => void openWorkspaceFromMenu(),
    openRecent: (p) => void openWorkspaceFromMenu(p),
    importSources: () => void importSources(),
    closeWorkspace,
    newSession: () => hostMsg({ type: "newSession" }),
    resumeSession: () => sendToMain({ type: "ui/openDrawer", drawer: "history" }),
    restartAgent: () => hostMsg({ type: "restartAgent" }),
    showPage: () => sendToMain({ type: "ui/promptShowPage" }),
    login: () => hostMsg({ type: "login" }),
    setModel: (provider, modelId) => hostMsg({ type: "setModel", provider, modelId }),
    setThinking: (level) => hostMsg({ type: "setThinkingLevel", level }),
    toggleYolo: () => hostMsg({ type: "setYolo", enabled: !hostState.yolo }),
    toggleTree: () => sendToMain({ type: "ui/toggle", pane: "tree" }),
    toggleChat: () => sendToMain({ type: "ui/toggle", pane: "chat" }),
    setTheme: setThemePref,
    // The View zoom items use Electron roles; these exist for the MenuActions contract.
    zoomIn: () => {},
    zoomOut: () => {},
    zoomReset: () => {},
    openDocs: open("https://github.com/ai-historian/chronos/blob/master/DOCS.md"),
    openDiscord: open("https://discord.gg/VZmfCnqkvz"),
    reportIssue: open("https://github.com/ai-historian/chronos/issues/new"),
    showLogs,
    about: () =>
      void dialog.showMessageBox({ type: "info", title: "About Chronos", message: "Chronos", detail: aboutText(), buttons: ["OK"] }),
  };
}

function rebuildMenu(): void {
  const hasWorkspace = !!(mainWindow && !mainWindow.isDestroyed());
  const state: MenuState = {
    ...hostState,
    theme: themePref,
    hasWorkspace,
    recent: recent ? recent.list() : [],
  };
  if (!hasWorkspace) Object.assign(state, { models: [], currentModel: undefined });
  const menu = buildMenu(menuActions(), state);
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
  if (process.env.CHRONOS_DEV_MENU_DUMP === "1") {
    const dump = Menu.getApplicationMenu()!.items.map((i) => `${i.label}(${i.submenu?.items.length ?? 0}${i.enabled ? "" : ",disabled"})`);
    console.log(`[chronos] menu: ${dump.join(" ")}`);
  }
}

app.whenReady().then(() => {
  recent = new RecentStore(join(app.getPath("userData"), "recent.json"));
  themePref = readAppSettings(app.getPath("userData")).theme;
  const vendor = resolveVendorPaths({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot: app.getAppPath() });
  console.log(`[chronos] pi cli: ${vendor.piCli} (agent: ${vendor.agentDir})`);
  rebuildMenu();
  installChronosFileHandler(() => (currentWorkspace ? [currentWorkspace] : []));
  const fromArgv = workspaceFromArgv(process.argv);
  if (!fromArgv) {
    createWelcomeWindow();
    return;
  }
  // Same checks as every other open; fall back to the welcome window if nothing opened.
  void openOrOfferInit(fromArgv, null).then(() => {
    if (!mainWindow || mainWindow.isDestroyed()) createWelcomeWindow();
  });
});
app.on("before-quit", () => {
  quitting = true;
  // If the main window's renderer pauses the quit for unsaved edits, finish it after window/close.
  if (mainWindow && !mainWindow.isDestroyed()) mainAfterClose = { kind: "quit" };
});
// macOS convention: closing the last window keeps the app running (in the dock); clicking the dock
// icon then reopens the welcome window. Linux/Windows quit with the last window.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (!app.isReady() || quitting || !recent) return;
  if (BrowserWindow.getAllWindows().length === 0) createWelcomeWindow();
});
