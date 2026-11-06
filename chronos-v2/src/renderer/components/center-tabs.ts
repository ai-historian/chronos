// <chronos-center-tabs>: the center pane's tab strip + body. Every tab's content stays mounted
// (only the active one is shown) so the page viewer, data viewer and open editors keep their state.
// The host supplies each tab's content via `renderTab` and owns the TabsModel; this element only
// reports intent: `tab-activate` / `tab-close` ({ id }).
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { Tab } from "../tabs-model";

export class ChronosCenterTabs extends LitElement {
  static properties = {
    tabs: { attribute: false },
    activeId: { type: String },
    renderTab: { attribute: false },
  };

  declare tabs: Tab[];
  declare activeId: string;
  declare renderTab: (tab: Tab) => unknown;

  constructor() {
    super();
    this.tabs = [];
    this.activeId = "";
    this.renderTab = () => nothing;
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  private emit(name: "tab-activate" | "tab-close", id: string): void {
    this.dispatchEvent(new CustomEvent(name, { detail: { id }, bubbles: true }));
  }

  render(): TemplateResult {
    return html`
      <div class="pv-tabs" role="tablist">
        ${repeat(
          this.tabs,
          (t) => t.id,
          (t) => {
            const closable = t.kind === "editor" || t.kind === "image";
            const active = t.id === this.activeId;
            return html`<div
              class="pv-tab ${active ? "is-active" : ""} ${closable ? "is-closable" : ""} ${t.dirty ? "is-dirty" : ""}"
              role="tab"
              tabindex="0"
              aria-selected=${active ? "true" : "false"}
              title=${t.path ?? t.title}
              @click=${() => this.emit("tab-activate", t.id)}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  this.emit("tab-activate", t.id);
                }
              }}
              @auxclick=${(e: MouseEvent) => {
                if (e.button === 1 && closable) {
                  e.preventDefault();
                  this.emit("tab-close", t.id);
                }
              }}
              @mousedown=${(e: MouseEvent) => {
                if (e.button === 1) e.preventDefault(); // no autoscroll cursor on middle-click
              }}
            >
              <span class="pv-tab-title">${t.title}</span>
              ${closable
                ? html`<button
                    class="pv-tab-close"
                    title=${t.dirty ? "Unsaved changes — close" : "Close"}
                    aria-label="Close ${t.title}"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      this.emit("tab-close", t.id);
                    }}
                  ><span class="pv-tab-dirty" aria-hidden="true"></span><span class="pv-tab-x" aria-hidden="true">✕</span></button>`
                : nothing}
            </div>`;
          },
        )}
      </div>
      <div class="pv-tab-body">
        ${repeat(
          this.tabs,
          (t) => t.id,
          (t) => html`<div class="ct-panel ct-panel-${t.kind}" role="tabpanel" ?hidden=${t.id !== this.activeId}>${this.renderTab(t)}</div>`,
        )}
      </div>
    `;
  }
}

/** <chronos-image-tab>: a workspace image in a scrollable container with page-viewer-style zoom. */
export class ChronosImageTab extends LitElement {
  static properties = {
    src: { type: String },
    zoom: { state: true },
    natW: { state: true },
  };

  declare src: string;
  /** Percent of natural width; 0 = fit to width (the default). */
  declare zoom: number;
  declare natW: number;

  constructor() {
    super();
    this.src = "";
    this.zoom = 0;
    this.natW = 0;
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  private setZoom(z: number): void {
    this.zoom = Math.max(25, Math.min(400, Math.round(z)));
  }

  private currentZoom(): number {
    if (this.zoom) return this.zoom;
    const box = this.querySelector<HTMLElement>(".it-scroll");
    if (!box || !this.natW) return 100;
    return Math.max(1, Math.round(((box.clientWidth - 32) / this.natW) * 100));
  }

  render(): TemplateResult {
    const style = this.zoom && this.natW ? `width:${(this.natW * this.zoom) / 100}px;max-width:none` : "";
    return html`
      <div class="it-root">
        <div class="pv-toolbar it-toolbar">
          <div class="pv-zoom">
            <button class="icon-btn" title="Zoom out" @click=${() => this.setZoom(this.currentZoom() - 25)}>−</button>
            <span class="pv-zoom-level">${this.natW ? `${this.currentZoom()}%` : ""}</span>
            <button class="icon-btn" title="Zoom in" @click=${() => this.setZoom(this.currentZoom() + 25)}>+</button>
            <button class="text-btn" title="Fit to width" @click=${() => (this.zoom = 0)}>Fit</button>
          </div>
        </div>
        <div class="it-scroll">
          <img
            class="it-img"
            src=${this.src}
            alt=""
            style=${style}
            @load=${(e: Event) => (this.natW = (e.target as HTMLImageElement).naturalWidth)}
          />
        </div>
      </div>
    `;
  }
}

customElements.define("chronos-center-tabs", ChronosCenterTabs);
customElements.define("chronos-image-tab", ChronosImageTab);

declare global {
  interface HTMLElementTagNameMap {
    "chronos-center-tabs": ChronosCenterTabs;
    "chronos-image-tab": ChronosImageTab;
  }
}
