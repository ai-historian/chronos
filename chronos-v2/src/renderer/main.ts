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
  window.dispatchEvent(new CustomEvent("chronos-theme-changed", { detail: { name } }));
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

// TEST-ONLY: the e2e suite (CHRONOS_E2E=1) reads the app's state snapshot directly.
if (chronos.isE2E()) (window as any).__chronosTestState = () => app.testState();

chronos.postMessage({ type: "ready" });
