import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveTheme, themeCss, type ThemeName } from "./theme";
import { WindowTransport } from "./window-transport";
import { AgentHost } from "./agent-host";
import { buildPiLaunch } from "./pi-launcher";
import { resolveVendorPaths } from "./paths";
import { registerChronosFileScheme, installChronosFileHandler, toChronosFileUrl } from "./protocol-handler";
import { providerChoices, saveApiKey, startAnthropicOauth, submitAnthropicOauthCode, cancelAnthropicOauth } from "./login";
import { RecentStore, pickFolderToCreate, pickWorkspaceToOpen } from "./workspace";
import { buildMenu, type MenuActions, type MenuState } from "./menu";
import { readAppSettings, writeAppSettings } from "./app-settings";
import type { ExtToWebview, WebviewToExt, WelcomeToExt } from "../shared/webview-protocol";

function workspaceFromArgv(argv: string[]): string | undefined {
  const i = argv.indexOf("--workspace");
  const dir = i >= 0 ? argv[i + 1] : undefined;
  return dir ? resolve(dir) : undefined;
}

// Must run before app is ready.
registerChronosFileScheme();

// Workspace the chronos-file:// handler is scoped to.
let currentWorkspace: string | undefined;
let mainWindow: BrowserWindow | undefined;
let welcomeWindow: BrowserWindow | undefined;
let quitting = false;
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
  else if (msg.type === "workspace/openRecent") path = isDirectory(msg.path) ? msg.path : null;
  if (path && !win.isDestroyed()) openMainWindow(path);
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
  currentWorkspace = workspaceDir;
  recent.add(workspaceDir);
  const win = createMainWindow(workspaceDir);
  mainWindow = win;
  // Swapping workspaces: the new window exists first, so the old one's close never reaches welcome/quit.
  old?.close();
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
  const onMsg = (e: Electron.IpcMainEvent, msg: WebviewToExt) => {
    if (e.sender !== win.webContents) return;
    void host?.handleWebviewMessage(msg);
  };
  ipcMain.on("chronos:msg", onMsg);

  host = new AgentHost({
    workspaceDir,
    transport,
    launch: (port) =>
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
  });
  const h = host;
  activeHost = h;
  hostState = { models: [], thinking: "off", yolo: false };
  const unsubscribe = h.onStateChange((st) => {
    hostState = st;
    rebuildMenu();
  });
  rebuildMenu();
  win.webContents.once("did-finish-load", () => void h.start());

  win.on("closed", () => {
    nativeTheme.off("updated", theme);
    ipcMain.off("chronos:msg", onMsg);
    cancelAnthropicOauth();
    unsubscribe();
    void host?.stop();
    if (activeHost === h) activeHost = undefined;
    if (mainWindow === win) {
      mainWindow = undefined;
      currentWorkspace = undefined;
    }
    rebuildMenu();
    if (!quitting && !mainWindow) createWelcomeWindow();
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

/** Placeholder until the import flow lands (Task 10 swaps this function). */
function importSources(): void {
  sendToMain({ type: "notify", level: "info", message: "Import is coming in a later task" });
}

function closeWorkspace(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); // returns to the welcome window
}

async function newWorkspaceFromMenu(): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow();
  const path = await pickFolderToCreate(parent);
  if (path) openWorkspaceFromMenu(path);
}

async function openWorkspaceFromMenu(path?: string): Promise<void> {
  const target = path ?? (await pickWorkspaceToOpen(BrowserWindow.getFocusedWindow()));
  if (!target) return;
  openMainWindow(target, true);
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
  const dir = app.getPath("logs");
  mkdirSync(dir, { recursive: true });
  shell.showItemInFolder(dir);
}

function menuActions(): MenuActions {
  const open = (url: string) => () => void shell.openExternal(url);
  return {
    newWorkspace: () => void newWorkspaceFromMenu(),
    openWorkspace: () => void openWorkspaceFromMenu(),
    openRecent: (p) => void (isDirectory(p) ? openWorkspaceFromMenu(p) : undefined),
    importSources,
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
  rebuildMenu();
  installChronosFileHandler(() => (currentWorkspace ? [currentWorkspace] : []));
  const fromArgv = workspaceFromArgv(process.argv);
  if (fromArgv) openMainWindow(fromArgv);
  else createWelcomeWindow();
});
app.on("before-quit", () => {
  quitting = true;
});
app.on("window-all-closed", () => app.quit());
