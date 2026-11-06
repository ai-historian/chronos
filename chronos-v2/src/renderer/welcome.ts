import { LitElement, html } from "lit";
import "./welcome.css";
import brandIcon from "./assets/chronos-icon.png";
import type { ExtToWelcome, WelcomeToExt } from "../shared/webview-protocol";

// The shared preload types window.chronos for the main window's protocol; the welcome
// window speaks its own pair, so cast at the boundary.
const bridge = window.chronos as unknown as {
  postMessage(msg: WelcomeToExt): void;
  onMessage(cb: (msg: ExtToWelcome) => void): void;
};

function applyTheme(name: string, css: string): void {
  document.documentElement.dataset.theme = name;
  let el = document.getElementById("chronos-theme");
  if (!el) {
    el = document.createElement("style");
    el.id = "chronos-theme";
    document.head.appendChild(el);
  }
  el.textContent = css;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

class ChronosWelcome extends LitElement {
  static properties = { items: { state: true } };
  declare items: { path: string; openedAt: number }[];

  constructor() {
    super();
    this.items = [];
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  handleMessage(msg: ExtToWelcome): void {
    if (msg.type === "workspace/recent") this.items = msg.items;
  }

  render() {
    return html`
      <div class="brand"><img src=${brandIcon} alt="" /><h1>Chronos</h1></div>
      <div class="actions">
        <button @click=${() => bridge.postMessage({ type: "workspace/open" })}>Open workspace…</button>
        <button class="secondary" @click=${() => bridge.postMessage({ type: "workspace/create" })}>Create workspace…</button>
      </div>
      <h2>Recent</h2>
      <div class="recent">
        ${this.items.length === 0
          ? html`<div class="empty">No recent workspaces</div>`
          : this.items.map(
              (i) => html`<button class="item" title=${i.path} @click=${() => bridge.postMessage({ type: "workspace/openRecent", path: i.path })}>
                <span class="name">${baseName(i.path)}</span><span class="path">${i.path}</span>
              </button>`,
            )}
      </div>
    `;
  }
}
customElements.define("chronos-welcome", ChronosWelcome);

const el = document.createElement("chronos-welcome") as ChronosWelcome;
document.body.appendChild(el);
bridge.onMessage((msg) => {
  if (msg.type === "theme") applyTheme(msg.name, msg.css);
  else el.handleMessage(msg);
});
