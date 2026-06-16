import { LitElement, html, nothing, type TemplateResult } from "lit";
import type { WebviewToExt } from "../../src/panel/webview-protocol";

interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TextView {
  filePath: string;
  content: string;
  highlight: string | null;
}

// Port of the standalone page-viewer panel (src/page-viewer.ts inline JS):
// zoom, fit-to-width, page navigation, bbox canvas crop, text + highlight.
export class ChronosPageViewer extends LitElement {
  static properties = {
    imageUri: { state: true },
    pageId: { state: true },
    sourceName: { state: true },
    firstPage: { state: true },
    lastPage: { state: true },
    textView: { state: true },
    zoom: { state: true },
    showingCrop: { state: true },
  };

  declare imageUri: string;
  declare pageId: number;
  declare sourceName: string;
  declare firstPage: number;
  declare lastPage: number;
  declare textView: TextView | null;
  declare zoom: number;
  declare showingCrop: boolean;

  private bbox: Bbox | null = null;
  private postMessage: (msg: WebviewToExt) => void = () => {};

  constructor() {
    super();
    this.imageUri = "";
    this.pageId = 1;
    this.sourceName = "";
    this.firstPage = 1;
    this.lastPage = 1;
    this.textView = null;
    this.zoom = 100;
    this.showingCrop = false;
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  setPostMessage(fn: (msg: WebviewToExt) => void): void {
    this.postMessage = fn;
  }

  showPage(imageUri: string, pageId: number, sourceName: string, firstPage: number, lastPage: number, bbox: Bbox | null): void {
    this.textView = null;
    this.pageId = pageId;
    this.sourceName = sourceName;
    this.firstPage = firstPage;
    this.lastPage = lastPage;
    this.bbox = bbox;
    if (this.imageUri === imageUri) {
      // Same image, maybe a different crop — the load handler won't re-fire
      this.applyBbox();
    } else {
      this.imageUri = imageUri;
    }
  }

  showText(view: TextView, sourceName: string): void {
    this.textView = view;
    this.sourceName = sourceName;
    // Render, then scroll the first highlight into view
    void this.updateComplete.then(() => {
      this.querySelector("mark")?.scrollIntoView({ block: "center" });
    });
  }

  updateRange(firstPage: number, lastPage: number): void {
    this.firstPage = firstPage;
    this.lastPage = lastPage;
  }

  private get img(): HTMLImageElement | null {
    return this.querySelector<HTMLImageElement>("#pv-image");
  }

  private get cropCanvas(): HTMLCanvasElement | null {
    return this.querySelector<HTMLCanvasElement>("#pv-crop");
  }

  private get container(): HTMLElement | null {
    return this.querySelector<HTMLElement>("#pv-scroll");
  }

  private navigate(pageId: number): void {
    const clamped = Math.max(this.firstPage, Math.min(this.lastPage, pageId));
    this.postMessage({ type: "viewer/navigate", pageId: clamped });
  }

  private onImageLoad(): void {
    this.applyBbox();
  }

  private applyBbox(): void {
    const img = this.img;
    if (!img || !img.complete || img.naturalWidth === 0) return;
    if (this.bbox) {
      const canvas = this.cropCanvas;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const { naturalWidth: w, naturalHeight: h } = img;
      const sx = this.bbox.x * w;
      const sy = this.bbox.y * h;
      const sw = this.bbox.w * w;
      const sh = this.bbox.h * h;
      canvas.width = sw;
      canvas.height = sh;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      this.showingCrop = true;
    } else {
      this.showingCrop = false;
    }
    void this.updateComplete.then(() => this.fitToWidth());
  }

  private displayNaturalWidth(): number {
    if (this.showingCrop) return this.cropCanvas?.width ?? 0;
    return this.img?.naturalWidth ?? 0;
  }

  private setZoom(zoom: number): void {
    this.zoom = Math.max(25, Math.min(400, zoom));
    this.applyZoomStyle();
  }

  private applyZoomStyle(): void {
    const el = this.showingCrop ? this.cropCanvas : this.img;
    const natW = this.displayNaturalWidth();
    if (el && natW > 0) {
      el.style.width = `${(natW * this.zoom) / 100}px`;
      el.style.height = "auto";
    }
  }

  private fitToWidth(): void {
    const natW = this.displayNaturalWidth();
    const container = this.container;
    if (natW > 0 && container) {
      // Leave a small gutter so the page shadow isn't clipped
      this.zoom = Math.max(25, Math.min(400, Math.round(((container.clientWidth - 32) / natW) * 100)));
    }
    this.applyZoomStyle();
  }

  private onWheel(e: WheelEvent): void {
    if (!e.ctrlKey) return;
    e.preventDefault();
    this.setZoom(this.zoom + (e.deltaY < 0 ? 10 : -10));
  }

  handleKeydown(e: KeyboardEvent): void {
    if (this.textView || !this.imageUri) return;
    if (e.key === "ArrowLeft") this.navigate(this.pageId - (e.shiftKey ? 10 : 1));
    if (e.key === "ArrowRight") this.navigate(this.pageId + (e.shiftKey ? 10 : 1));
  }

  protected updated(): void {
    this.applyZoomStyle();
  }

  // ── test seam ───────────────────────────────────────────────────────────
  testSnapshot(): {
    pageId: number;
    sourceName: string;
    hasImage: boolean;
    showingCrop: boolean;
    textFile: string | null;
  } {
    return {
      pageId: this.pageId,
      sourceName: this.sourceName,
      hasImage: !!this.imageUri,
      showingCrop: this.showingCrop,
      textFile: this.textView?.filePath ?? null,
    };
  }

  render(): TemplateResult {
    return html`
      <div class="pv-root">
        ${this.renderToolbar()}
        <div
          id="pv-scroll"
          class="pv-scroll ${this.textView ? "is-text" : ""}"
          @wheel=${this.onWheel}
        >
          ${this.textView ? this.renderText() : this.renderImage()}
        </div>
      </div>
    `;
  }

  private renderToolbar(): TemplateResult {
    const onPage = !this.textView && !!this.imageUri;
    return html`
      <div class="pv-toolbar">
        <div class="pv-nav">
          <button class="icon-btn" title="Back 10 pages" ?disabled=${!onPage || this.pageId <= this.firstPage}
            @click=${() => this.navigate(this.pageId - 10)}>«</button>
          <button class="icon-btn" title="Previous page" ?disabled=${!onPage || this.pageId <= this.firstPage}
            @click=${() => this.navigate(this.pageId - 1)}>‹</button>
          <span class="pv-pageno">
            <input
              type="number"
              .value=${String(this.pageId)}
              min=${this.firstPage}
              max=${this.lastPage}
              ?disabled=${!onPage}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") {
                  const val = parseInt((e.target as HTMLInputElement).value, 10);
                  if (!isNaN(val)) this.navigate(val);
                }
              }}
              @change=${(e: Event) => {
                const val = parseInt((e.target as HTMLInputElement).value, 10);
                if (!isNaN(val)) this.navigate(val);
              }}
            />
            <span class="pv-total">/ ${this.lastPage}</span>
          </span>
          <button class="icon-btn" title="Next page" ?disabled=${!onPage || this.pageId >= this.lastPage}
            @click=${() => this.navigate(this.pageId + 1)}>›</button>
          <button class="icon-btn" title="Forward 10 pages" ?disabled=${!onPage || this.pageId >= this.lastPage}
            @click=${() => this.navigate(this.pageId + 10)}>»</button>
        </div>
        <div class="pv-zoom">
          ${this.showingCrop
            ? html`<button class="text-btn" title="Show the full page" @click=${() => { this.bbox = null; this.applyBbox(); }}>Full page</button>`
            : nothing}
          <button class="icon-btn" title="Zoom out" ?disabled=${!onPage} @click=${() => this.setZoom(this.zoom - 25)}>−</button>
          <span class="pv-zoom-level">${this.zoom}%</span>
          <button class="icon-btn" title="Zoom in" ?disabled=${!onPage} @click=${() => this.setZoom(this.zoom + 25)}>+</button>
          <button class="text-btn" title="Fit to width" ?disabled=${!onPage} @click=${() => this.fitToWidth()}>Fit</button>
        </div>
      </div>
    `;
  }

  private renderImage(): TemplateResult {
    if (!this.imageUri) {
      return html`
        <div class="pv-empty">
          <svg class="pv-empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25">
            <rect x="5" y="3" width="14" height="18" rx="1.5"/>
            <line x1="8.5" y1="8" x2="15.5" y2="8"/>
            <line x1="8.5" y1="12" x2="15.5" y2="12"/>
            <line x1="8.5" y1="16" x2="12.5" y2="16"/>
          </svg>
          <div class="pv-empty-title">No page selected</div>
          <div class="pv-empty-hint">Choose a source to view its pages here.</div>
        </div>
      `;
    }
    return html`
      <div class="pv-stage">
        <img
          id="pv-image"
          src=${this.imageUri}
          alt="Page ${this.pageId}"
          style=${this.showingCrop ? "display:none" : ""}
          @load=${this.onImageLoad}
        />
        <canvas id="pv-crop" style=${this.showingCrop ? "" : "display:none"}></canvas>
      </div>
    `;
  }

  private renderText(): TemplateResult {
    const view = this.textView!;
    const fileName = view.filePath.split(/[/\\]/).pop() ?? view.filePath;
    let body: TemplateResult;
    if (view.highlight && view.content.includes(view.highlight)) {
      const parts = view.content.split(view.highlight);
      const joined: (string | TemplateResult)[] = [];
      parts.forEach((part, i) => {
        joined.push(part);
        if (i < parts.length - 1) joined.push(html`<mark>${view.highlight}</mark>`);
      });
      body = html`<pre>${joined}</pre>`;
    } else {
      body = html`<pre>${view.content}</pre>`;
    }
    return html`
      <div class="pv-text">
        <div class="pv-text-label">${fileName}</div>
        ${body}
      </div>
    `;
  }
}

customElements.define("chronos-page-viewer", ChronosPageViewer);

declare global {
  interface HTMLElementTagNameMap {
    "chronos-page-viewer": ChronosPageViewer;
  }
}
