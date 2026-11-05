import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { join, resolve } from "node:path";
import { resolveTheme, themeCss } from "./theme";
import { WindowTransport } from "./window-transport";
import { AgentHost } from "./agent-host";
import { buildPiLaunch } from "./pi-launcher";
import { resolveVendorPaths } from "./paths";
import { registerChronosFileScheme, installChronosFileHandler, toChronosFileUrl } from "./protocol-handler";
import type { WebviewToExt } from "../shared/webview-protocol";

// Workspace for now comes from `--workspace <dir>`; Task 7 adds the welcome flow.
function workspaceFromArgv(argv: string[]): string | undefined {
  const i = argv.indexOf("--workspace");
  const dir = i >= 0 ? argv[i + 1] : undefined;
  return dir ? resolve(dir) : undefined;
}

// Must run before app is ready.
registerChronosFileScheme();

// Workspace the chronos-file:// handler is scoped to.
let currentWorkspace: string | undefined;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Chronos",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
    },
  });
  const transport = new WindowTransport(win);
  const sendTheme = () => {
    const name = resolveTheme("system", nativeTheme.shouldUseDarkColors);
    transport.post({ type: "theme", name, css: themeCss(name) });
  };
  win.webContents.on("did-finish-load", sendTheme);
  nativeTheme.on("updated", sendTheme);

  const workspaceDir = workspaceFromArgv(process.argv);
  currentWorkspace = workspaceDir;
  let host: AgentHost | undefined;
  const onMsg = (e: Electron.IpcMainEvent, msg: WebviewToExt) => {
    if (e.sender !== win.webContents) return;
    void host?.handleWebviewMessage(msg);
  };
  ipcMain.on("chronos:msg", onMsg);

  if (workspaceDir) {
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
  } else {
    console.log("[chronos] no --workspace <dir> given; opening without an agent");
  }

  win.on("closed", () => {
    nativeTheme.off("updated", sendTheme);
    ipcMain.off("chronos:msg", onMsg);
    void host?.stop();
  });
  // Dev aid: CHRONOS_DEV_PROTOCOL_CHECK=1 loads an in-workspace PNG (expect loaded) and an outside file (expect blocked, i.e. 403) via <img>, since the renderer CSP forbids fetch().
  if (process.env.CHRONOS_DEV_PROTOCOL_CHECK === "1" && workspaceDir) {
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
}

app.whenReady().then(() => {
  installChronosFileHandler(() => (currentWorkspace ? [currentWorkspace] : []));
  createWindow();
});
app.on("window-all-closed", () => app.quit());
