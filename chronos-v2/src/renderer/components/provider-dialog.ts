import { LitElement, html, nothing, type TemplateResult } from "lit";
import type { WebviewToExt } from "../../shared/webview-protocol";

// In-app provider login: save a provider API key to the workspace .env, or
// sign in with a Claude Pro/Max subscription (OAuth in the system browser,
// with a manual code-paste fallback). Light DOM so the app stylesheet applies.
// The key is only read from the input on submit and never logged.

export interface ProviderOption {
  id: string;
  label: string;
  envVar: string;
}

export interface OauthStatusView {
  status: "waiting" | "done" | "error";
  message?: string;
}

const ENV_VAR_RE = /^[A-Z][A-Z0-9_]*$/;

export class ChronosProviderDialog extends LitElement {
  static properties = {
    providers: { attribute: false },
    oauthStatus: { attribute: false },
    selectedId: { state: true },
    error: { state: true },
  };

  declare providers: ProviderOption[];
  declare oauthStatus: OauthStatusView | null;
  declare selectedId: string;
  declare error: string;

  /** Set by the parent: posts a message to the main process. */
  post: (msg: WebviewToExt) => void = () => {};

  constructor() {
    super();
    this.providers = [];
    this.oauthStatus = null;
    this.selectedId = "";
    this.error = "";
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  private get selected(): ProviderOption | undefined {
    return this.providers.find((p) => p.id === this.selectedId) ?? this.providers[0];
  }

  private value(id: string): string {
    return this.querySelector<HTMLInputElement>(`#${id}`)?.value.trim() ?? "";
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent("close"));
  }

  private cancel(): void {
    this.post({ type: "login/cancel" });
    this.close();
  }

  private connect(): void {
    const provider = this.selected;
    if (!provider) return;
    const envVar = provider.id === "other" ? this.value("provider-envvar") : provider.envVar;
    if (!ENV_VAR_RE.test(envVar)) {
      this.error = "Enter an environment variable name like TOGETHER_API_KEY (A–Z, 0–9, _).";
      return;
    }
    const key = this.value("provider-key");
    if (!key || /[\r\n]/.test(key)) {
      this.error = "Paste the API key.";
      return;
    }
    this.post({ type: "login/apiKey", envVar, key });
    // The agent restarts and repopulates the model list; nothing left to show.
    this.close();
  }

  private startOauth(): void {
    this.error = "";
    this.oauthStatus = { status: "waiting", message: "Opening your browser…" };
    this.post({ type: "login/oauth" });
  }

  private submitCode(): void {
    const code = this.value("provider-oauth-code");
    if (!code) return;
    this.post({ type: "login/oauthCode", code });
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      this.cancel();
    }
  }

  private renderOauth(): TemplateResult {
    const st = this.oauthStatus;
    if (!st) {
      return html`
        <button class="dialog-option provider-oauth-btn" @click=${this.startOauth}>
          Use Claude subscription
          <span class="provider-hint">Claude Pro/Max — sign in with your browser, no API key</span>
        </button>
      `;
    }
    return html`
      <div class="provider-oauth-status ${st.status === "error" ? "is-error" : ""}" role="status">
        ${st.status === "waiting" ? html`<span class="spinner"></span>` : nothing}
        <span>${st.message ?? (st.status === "error" ? "Sign-in failed." : "Waiting for the browser…")}</span>
      </div>
      ${st.status === "error"
        ? html`<div class="dialog-actions provider-row">
            <button class="btn-secondary" @click=${this.startOauth}>Try again</button>
          </div>`
        : html`<div class="provider-row provider-code-row">
            <input
              id="provider-oauth-code"
              class="dialog-input"
              placeholder="Paste code or redirect URL"
              autocomplete="off"
              spellcheck="false"
              @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.submitCode()}
            />
            <button class="btn-secondary" @click=${this.submitCode}>Paste code</button>
          </div>`}
    `;
  }

  render(): TemplateResult {
    const provider = this.selected;
    const isOther = provider?.id === "other";
    return html`
      <div class="dialog-backdrop" @click=${this.cancel}></div>
      <div class="dialog provider-dialog" role="dialog" aria-modal="true" aria-label="Connect an AI provider" @keydown=${this.onKeydown}>
        <div class="dialog-title">Connect an AI provider</div>
        ${this.renderOauth()}
        <div class="provider-divider"><span>or use an API key</span></div>
        <label class="provider-label" for="provider-select">Provider</label>
        <select
          id="provider-select"
          class="control-select provider-select"
          .value=${provider?.id ?? ""}
          @change=${(e: Event) => {
            this.selectedId = (e.target as HTMLSelectElement).value;
            this.error = "";
          }}
        >
          ${this.providers.map((p) => html`<option value=${p.id} ?selected=${p.id === provider?.id}>${p.label}</option>`)}
        </select>
        ${isOther
          ? html`<label class="provider-label" for="provider-envvar">Environment variable</label>
              <input id="provider-envvar" class="dialog-input" placeholder="e.g. TOGETHER_API_KEY" autocomplete="off" spellcheck="false" />`
          : nothing}
        <label class="provider-label" for="provider-key">API key${provider && !isOther ? html` <span class="provider-hint">(${provider.envVar})</span>` : nothing}</label>
        <input
          id="provider-key"
          class="dialog-input"
          type="password"
          autocomplete="off"
          spellcheck="false"
          @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.connect()}
        />
        ${this.error ? html`<div class="provider-error" role="alert">${this.error}</div>` : nothing}
        <div class="dialog-actions">
          <button class="btn-secondary" @click=${this.cancel}>Cancel</button>
          <button class="btn-send" @click=${this.connect}>Connect</button>
        </div>
      </div>
    `;
  }
}

customElements.define("chronos-provider-dialog", ChronosProviderDialog);
