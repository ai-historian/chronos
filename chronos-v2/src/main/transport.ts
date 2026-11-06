import type { ExtToWebview } from "../shared/webview-protocol";

export interface Transport {
  post(msg: ExtToWebview): void;
}
