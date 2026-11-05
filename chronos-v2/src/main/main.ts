import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { join, resolve } from "node:path";
import { resolveTheme, themeCss } from "./theme";
import { WindowTransport } from "./window-transport";
import { AgentHost } from "./agent-host";
import { buildPiLaunch } from "./pi-launcher";
import { resolveVendorPaths } from "./paths";
import type { WebviewToExt } from "../shared/webview-protocol";

// Workspace for now comes from `--workspace <dir>`; Task 7 adds the welcome flow.
function workspaceFromArgv(argv: string[]): string | undefined {
  const i = argv.indexOf("--workspace");
  const dir = i >= 0 ? argv[i + 1] : undefined;
  return dir ? resolve(dir) : undefined;
}

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
      // Placeholder until Task 6 registers the chronos-file:// protocol.
      imageUri: (p) => "file://" + p,
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
  void win.loadFile(join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
