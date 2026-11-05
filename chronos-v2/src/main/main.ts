import { app, BrowserWindow, nativeTheme } from "electron";
import { join } from "node:path";
import { resolveTheme, themeCss } from "./theme";
import { WindowTransport } from "./window-transport";

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
  win.on("closed", () => nativeTheme.off("updated", sendTheme));
  void win.loadFile(join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
