import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveTheme, themeCss } from "./theme";
import { WindowTransport } from "./window-transport";
import { AgentHost } from "./agent-host";
import { buildPiLaunch } from "./pi-launcher";
import { resolveVendorPaths } from "./paths";
import { registerChronosFileScheme, installChronosFileHandler, toChronosFileUrl } from "./protocol-handler";
import { RecentStore, pickFolderToCreate, pickWorkspaceToOpen } from "./workspace";
import type { WebviewToExt, WelcomeToExt } from "../shared/webview-protocol";

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

function webPrefs(): Electron.WebPreferences {
  return { preload: join(__dirname, "preload.js"), contextIsolation: true, sandbox: false };
}

function sendTheme(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  const name = resolveTheme("system", nativeTheme.shouldUseDarkColors);
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
function openMainWindow(workspaceDir: string): void {
  workspaceDir = resolve(workspaceDir);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
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
  });
  const h = host;
  win.webContents.once("did-finish-load", () => void h.start());

  win.on("closed", () => {
    nativeTheme.off("updated", theme);
    ipcMain.off("chronos:msg", onMsg);
    void host?.stop();
    if (mainWindow === win) mainWindow = undefined;
    currentWorkspace = undefined;
    if (!quitting) createWelcomeWindow();
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

app.whenReady().then(() => {
  recent = new RecentStore(join(app.getPath("userData"), "recent.json"));
  installChronosFileHandler(() => (currentWorkspace ? [currentWorkspace] : []));
  const fromArgv = workspaceFromArgv(process.argv);
  if (fromArgv) openMainWindow(fromArgv);
  else createWelcomeWindow();
});
app.on("before-quit", () => {
  quitting = true;
});
app.on("window-all-closed", () => app.quit());
