import type { ExtToWebview, WebviewToExt } from "../shared/webview-protocol";

declare global {
  interface Window {
    chronos: {
      postMessage(msg: WebviewToExt): void;
      onMessage(cb: (msg: ExtToWebview) => void): void;
      getState(): unknown;
      setState(s: unknown): void;
      isE2E(): boolean;
    };
  }
}
export {};
