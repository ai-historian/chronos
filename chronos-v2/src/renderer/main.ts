import "./components/chronos-app";
import "./styles.css";
import type { ExtToWebview } from "../shared/webview-protocol";
import type { ChronosApp } from "./components/chronos-app";

const chronos = window.chronos;

function applyTheme(name: string, css: string): void {
  document.documentElement.dataset.theme = name;
  document.body.classList.remove("vscode-dark", "vscode-light");
  document.body.classList.add(name === "dark" ? "vscode-dark" : "vscode-light");
  let el = document.getElementById("chronos-theme");
  if (!el) {
    el = document.createElement("style");
    el.id = "chronos-theme";
    document.head.appendChild(el);
  }
  el.textContent = css;
}

const app = document.createElement("chronos-app") as ChronosApp;
app.setPostMessage((msg) => chronos.postMessage(msg));
app.restoreUiState(chronos.getState() as Parameters<ChronosApp["restoreUiState"]>[0]);
app.addEventListener("ui-state-changed", () => chronos.setState(app.getUiState()));
document.body.appendChild(app);

chronos.onMessage((msg: ExtToWebview) => {
  if (msg.type === "theme") applyTheme(msg.name, msg.css);
  else app.handleMessage(msg);
});

chronos.postMessage({ type: "ready" });
