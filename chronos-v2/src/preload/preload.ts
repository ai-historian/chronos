import { contextBridge, ipcRenderer } from "electron";
import type { ExtToWebview, WebviewToExt } from "../shared/webview-protocol";

const STATE_KEY = "chronos.uiState";

contextBridge.exposeInMainWorld("chronos", {
  postMessage(msg: WebviewToExt): void {
    ipcRenderer.send("chronos:msg", msg);
  },
  onMessage(cb: (msg: ExtToWebview) => void): void {
    ipcRenderer.on("chronos:msg", (_e, msg: ExtToWebview) => cb(msg));
  },
  getState(): unknown {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      return raw === null ? undefined : JSON.parse(raw);
    } catch {
      return undefined;
    }
  },
  /** TEST-ONLY: true when launched by the e2e suite (CHRONOS_E2E=1). */
  isE2E(): boolean {
    return process.env.CHRONOS_E2E === "1";
  },
  setState(s: unknown): void {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(s));
    } catch {
      /* storage unavailable */
    }
  },
});
