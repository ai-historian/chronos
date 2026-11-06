import type { BrowserWindow } from "electron";
import type { ExtToWebview } from "../shared/webview-protocol";
import type { Transport } from "./transport";

export class WindowTransport implements Transport {
  constructor(private readonly win: BrowserWindow) {}

  post(msg: ExtToWebview): void {
    if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) return;
    this.win.webContents.send("chronos:msg", msg);
  }
}
