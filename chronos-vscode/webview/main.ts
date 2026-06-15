import "./components/chronos-app";
import "./styles.css";
import type { ExtToWebview, WebviewToExt } from "../src/panel/webview-protocol";
import type { ChronosApp } from "./components/chronos-app";

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToExt): void;
  getState(): any;
  setState(state: any): void;
};

const vscode = acquireVsCodeApi();

const app = document.createElement("chronos-app") as ChronosApp;
app.setPostMessage((msg) => vscode.postMessage(msg));
app.restoreUiState(vscode.getState());
app.addEventListener("ui-state-changed", () => vscode.setState(app.getUiState()));
document.body.appendChild(app);

window.addEventListener("message", (e: MessageEvent<ExtToWebview>) => {
  app.handleMessage(e.data);
});

vscode.postMessage({ type: "ready" });
