import { LitElement, html, nothing, type TemplateResult } from "lit";
import type { Bbox, WebviewToExt } from "../../src/panel/webview-protocol";

// Reserved per-row keys that carry provenance. When present they are hidden
// from the table body and rendered as a "view source" action that jumps the
// page viewer to the cited page/region (reusing the openViewLink path).
const RESERVED = {
  page: "chronos_page",
  bbox: "chronos_bbox",
  source: "chronos_source",
} as const;

interface Row {
  [key: string]: unknown;
}

interface Provenance {
  pageId: number;
  bbox: Bbox | null;
  sourcePath?: string;
}

// An inline crop preview shown at the bottom of the data viewer. The source
// viewer is independent — "Show full page" is the only thing that crosses over.
interface Preview {
  pageId: number;
  bbox: Bbox | null;
  sourcePath?: string;
  sourceName: string;
  imageUri: string; // "" until the host resolves it
}

type Parsed =
  | { kind: "table"; columns: string[]; rows: Row[]; provenance: (Provenance | null)[] }
  | { kind: "text"; text: string };

// Coerce a chronos_bbox value ([x,y,w,h] or {x,y,w,h}) to a Bbox, else null.
function toBbox(value: unknown): Bbox | null {
  if (Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number")) {
    const [x, y, w, h] = value as number[];
    return { x, y, w, h };
  }
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (["x", "y", "w", "h"].every((k) => typeof o[k] === "number")) {
      return { x: o.x as number, y: o.y as number, w: o.w as number, h: o.h as number };
    }
  }
  return null;
}

function rowProvenance(row: Row): Provenance | null {
  const raw = row[RESERVED.page];
  const pageId = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (isNaN(pageId)) return null;
  const sourcePath = typeof row[RESERVED.source] === "string" ? (row[RESERVED.source] as string) : undefined;
  return { pageId, bbox: toBbox(row[RESERVED.bbox]), sourcePath };
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export class ChronosDataViewer extends LitElement {
  static properties = {
    sourceName: { state: true },
    files: { state: true },
    selected: { state: true },
    content: { state: true },
    loading: { state: true },
    sortColumn: { state: true },
    sortDir: { state: true },
    preview: { state: true },
    previewPct: { state: true },
  };

  declare sourceName: string;
  declare files: string[];
  declare selected: string | null;
  declare content: string | null;
  declare loading: boolean;
  declare sortColumn: string | null;
  declare sortDir: 1 | -1;
  declare preview: Preview | null;
  declare previewPct: number;

  private postMessage: (msg: WebviewToExt) => void = () => {};

  constructor() {
    super();
    this.sourceName = "";
    this.files = [];
    this.selected = null;
    this.content = null;
    this.loading = false;
    this.sortColumn = null;
    this.sortDir = 1;
    this.preview = null;
    this.previewPct = 30;
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  setPostMessage(fn: (msg: WebviewToExt) => void): void {
    this.postMessage = fn;
  }

  // New / refreshed list of data files for the active source.
  setFiles(sourceName: string, files: string[]): void {
    const sourceChanged = sourceName !== this.sourceName;
    this.sourceName = sourceName;
    this.files = files;
    if (sourceChanged) {
      // Different source — reset to its first file.
      this.selectFile(files[0] ?? null);
    } else if (this.selected && !files.includes(this.selected)) {
      // The open file disappeared — fall back to the first available.
      this.selectFile(files[0] ?? null);
    } else if (!this.selected && files.length) {
      this.selectFile(files[0]);
    }
  }

  showFile(filename: string, content: string): void {
    // Ignore stale responses for a file the user already navigated away from.
    if (filename !== this.selected) return;
    this.content = content;
    this.loading = false;
  }

  private selectFile(filename: string | null): void {
    this.selected = filename;
    this.content = null;
    this.sortColumn = null;
    this.preview = null;
    if (filename) {
      this.loading = true;
      this.postMessage({ type: "data/load", filename });
    }
  }

  private refresh(): void {
    this.postMessage({ type: "data/listRequest" });
    if (this.selected) {
      this.loading = true;
      this.postMessage({ type: "data/load", filename: this.selected });
    }
  }

  private parse(content: string): Parsed {
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      return { kind: "text", text: content };
    }
    const rows: Row[] = Array.isArray(json)
      ? json.every((r) => r && typeof r === "object" && !Array.isArray(r))
        ? (json as Row[])
        : []
      : json && typeof json === "object"
        ? [json as Row]
        : [];
    if (rows.length === 0) {
      // Arrays of primitives / scalars — show pretty JSON as text.
      return { kind: "text", text: JSON.stringify(json, null, 2) };
    }
    const reserved = new Set<string>(Object.values(RESERVED));
    const columns: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!reserved.has(key) && !columns.includes(key)) columns.push(key);
      }
    }
    const provenance = rows.map(rowProvenance);
    return { kind: "table", columns, rows, provenance };
  }

  private sortRows(parsed: Extract<Parsed, { kind: "table" }>): { rows: Row[]; provenance: (Provenance | null)[] } {
    if (!this.sortColumn) return { rows: parsed.rows, provenance: parsed.provenance };
    const col = this.sortColumn;
    const dir = this.sortDir;
    const indices = parsed.rows.map((_, i) => i);
    indices.sort((ia, ib) => {
      const a = parsed.rows[ia][col];
      const b = parsed.rows[ib][col];
      if (typeof a === "number" && typeof b === "number") return (a - b) * dir;
      return formatCell(a).localeCompare(formatCell(b)) * dir;
    });
    return {
      rows: indices.map((i) => parsed.rows[i]),
      provenance: indices.map((i) => parsed.provenance[i]),
    };
  }

  private toggleSort(column: string): void {
    if (this.sortColumn === column) {
      this.sortDir = this.sortDir === 1 ? -1 : 1;
    } else {
      this.sortColumn = column;
      this.sortDir = 1;
    }
  }

  // Row "view source": show the cited region inline at the bottom of the data
  // viewer. Stays here — the source viewer is independent.
  private viewSource(prov: Provenance): void {
    this.preview = {
      pageId: prov.pageId,
      bbox: prov.bbox,
      sourcePath: prov.sourcePath,
      sourceName: this.sourceName,
      imageUri: "",
    };
    this.postMessage({ type: "data/previewSource", pageId: prov.pageId, bbox: prov.bbox, sourcePath: prov.sourcePath });
  }

  // Host resolved the page image — fill in the preview and crop it.
  showSourcePreview(imageUri: string, pageId: number, bbox: Bbox | null, sourceName: string): void {
    this.preview = { ...(this.preview ?? {}), pageId, bbox, sourceName, imageUri };
    void this.updateComplete.then(() => this.applyPreviewCrop());
  }

  // "Show full page" is the only handoff to the source viewer.
  private showFullPage(): void {
    const p = this.preview;
    if (!p) return;
    this.postMessage({ type: "openViewLink", pageId: p.pageId, bbox: null, sourcePath: p.sourcePath });
  }

  private onPreviewImageLoad(): void {
    this.applyPreviewCrop();
  }

  // Zoom to the cited region plus a margin (the bbox enlarged by 40%), so the
  // viewer doesn't show the whole page. Within that crop the bbox is kept clear
  // with a bronze outline and the surrounding margin is dimmed for context.
  private applyPreviewCrop(): void {
    const p = this.preview;
    if (!p?.bbox) return;
    const img = this.querySelector<HTMLImageElement>("#dv-prev-img");
    const canvas = this.querySelector<HTMLCanvasElement>("#dv-prev-canvas");
    const ctx = canvas?.getContext("2d");
    if (!img || !canvas || !ctx || !img.complete || img.naturalWidth === 0) return;
    const { naturalWidth: w, naturalHeight: h } = img;

    const bx = p.bbox.x * w;
    const by = p.bbox.y * h;
    const bw = p.bbox.w * w;
    const bh = p.bbox.h * h;

    // Crop region = bbox grown to 140% of its size (20% margin per side), clamped.
    const padX = bw * 0.2;
    const padY = bh * 0.2;
    const cx = Math.max(0, bx - padX);
    const cy = Math.max(0, by - padY);
    const cw = Math.min(w, bx + bw + padX) - cx;
    const ch = Math.min(h, by + bh + padY) - cy;

    canvas.width = cw;
    canvas.height = ch;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);

    // bbox position relative to the crop.
    const lx = bx - cx;
    const ly = by - cy;
    // Dim the margin around the bbox (a little — context stays readable).
    ctx.fillStyle = "rgba(18, 18, 22, 0.4)";
    ctx.fillRect(0, 0, cw, ly); // top
    ctx.fillRect(0, ly + bh, cw, ch - (ly + bh)); // bottom
    ctx.fillRect(0, ly, lx, bh); // left
    ctx.fillRect(lx + bw, ly, cw - (lx + bw), bh); // right
    // Bronze outline on the cited region — thin and fully opaque.
    ctx.strokeStyle = "rgba(194, 135, 62, 1)";
    ctx.lineWidth = Math.max(1, Math.round(cw / 500));
    ctx.strokeRect(lx, ly, bw, bh);
  }

  // ── test seam ───────────────────────────────────────────────────────────
  testSelect(filename: string): void {
    this.selectFile(filename);
  }

  testViewFirstRow(): void {
    if (this.content === null) return;
    const parsed = this.parse(this.content);
    if (parsed.kind !== "table") return;
    const prov = parsed.provenance.find((p): p is Provenance => p !== null);
    if (prov) this.viewSource(prov);
  }

  testShowFullPage(): void {
    this.showFullPage();
  }

  testSnapshot(): {
    sourceName: string;
    files: string[];
    selected: string | null;
    kind: "table" | "text" | null;
    rowCount: number;
    columns: string[];
    hasProvenance: boolean;
    preview: { pageId: number; hasImage: boolean } | null;
  } {
    const parsed = this.content !== null ? this.parse(this.content) : null;
    return {
      sourceName: this.sourceName,
      files: this.files,
      selected: this.selected,
      kind: parsed?.kind ?? null,
      rowCount: parsed?.kind === "table" ? parsed.rows.length : 0,
      columns: parsed?.kind === "table" ? parsed.columns : [],
      hasProvenance: parsed?.kind === "table" ? parsed.provenance.some(Boolean) : false,
      preview: this.preview ? { pageId: this.preview.pageId, hasImage: !!this.preview.imageUri } : null,
    };
  }

  render(): TemplateResult {
    return html`
      <div class="dv-root">
        ${this.renderToolbar()}
        <div class="dv-scroll">${this.renderBody()}</div>
        ${this.preview
          ? html`
              <div class="dv-split" @pointerdown=${this.onPreviewSplitDown} title="Drag to resize"></div>
              ${this.renderPreview()}
            `
          : nothing}
      </div>
    `;
  }

  // Drag the splitter to resize the preview panel's share of the viewer height.
  private onPreviewSplitDown(e: PointerEvent): void {
    e.preventDefault();
    const root = this.querySelector<HTMLElement>(".dv-root");
    if (!root) return;
    const onMove = (ev: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      // Preview is docked at the bottom: its height is from the pointer to the foot.
      this.previewPct = Math.max(15, Math.min(70, ((rect.bottom - ev.clientY) / rect.height) * 100));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  private renderPreview(): TemplateResult {
    const p = this.preview!;
    return html`
      <div class="dv-preview" style="flex-basis:${this.previewPct}%">
        <div class="dv-preview-head">
          <span class="dv-preview-label">p. ${p.pageId}${p.sourceName ? ` · ${p.sourceName}` : ""}</span>
          <span class="dv-preview-spacer"></span>
          <button class="text-btn" title="Open the full page in the source viewer" @click=${() => this.showFullPage()}>
            Show full page
          </button>
          <button class="icon-btn" title="Close preview" @click=${() => (this.preview = null)}>✕</button>
        </div>
        <div class="dv-preview-stage">
          ${p.imageUri
            ? html`
                <img
                  id="dv-prev-img"
                  src=${p.imageUri}
                  alt="Page ${p.pageId}"
                  @load=${this.onPreviewImageLoad}
                  style=${p.bbox ? "display:none" : ""}
                />
                <canvas id="dv-prev-canvas" style=${p.bbox ? "" : "display:none"}></canvas>
              `
            : html`<span class="spinner"></span>`}
        </div>
      </div>
    `;
  }

  private renderToolbar(): TemplateResult {
    return html`
      <div class="pv-toolbar dv-toolbar">
        <label class="dv-file-picker">
          <select
            ?disabled=${this.files.length === 0}
            @change=${(e: Event) => this.selectFile((e.target as HTMLSelectElement).value || null)}
          >
            ${this.files.length === 0 ? html`<option>— no data files —</option>` : nothing}
            ${this.files.map(
              (f) => html`<option value=${f} ?selected=${f === this.selected}>${f}</option>`,
            )}
          </select>
        </label>
        <button class="text-btn" title="Reload data files" ?disabled=${!this.sourceName} @click=${() => this.refresh()}>
          Refresh
        </button>
      </div>
    `;
  }

  private renderBody(): TemplateResult {
    if (!this.sourceName) {
      return this.renderEmpty("No source selected", "Choose a source to see its extracted data here.");
    }
    if (this.files.length === 0) {
      return this.renderEmpty("No data yet", `Nothing in data/${this.sourceName}/ yet — extraction outputs will appear here.`);
    }
    if (this.loading || this.content === null) {
      return html`<div class="dv-empty"><span class="spinner"></span></div>`;
    }
    const parsed = this.parse(this.content);
    return parsed.kind === "table" ? this.renderTable(parsed) : html`<pre class="dv-text">${parsed.text}</pre>`;
  }

  private renderTable(parsed: Extract<Parsed, { kind: "table" }>): TemplateResult {
    const { rows, provenance } = this.sortRows(parsed);
    const hasProvenance = provenance.some(Boolean);
    return html`
      <table class="dv-table">
        <thead>
          <tr>
            ${hasProvenance ? html`<th class="dv-prov-head" title="Jump to source page">⤢</th>` : nothing}
            ${parsed.columns.map(
              (c) => html`<th @click=${() => this.toggleSort(c)} class=${this.sortColumn === c ? "is-sorted" : ""}>
                ${c}${this.sortColumn === c ? html`<span class="dv-sort">${this.sortDir === 1 ? "▲" : "▼"}</span>` : nothing}
              </th>`,
            )}
          </tr>
        </thead>
        <tbody>
          ${rows.map((row, i) => {
            const prov = provenance[i];
            return html`<tr>
              ${hasProvenance
                ? html`<td class="dv-prov">
                    ${prov
                      ? html`<button class="dv-view" title="View source p.${prov.pageId}" @click=${() => this.viewSource(prov)}>
                          p.${prov.pageId}
                        </button>`
                      : nothing}
                  </td>`
                : nothing}
              ${parsed.columns.map((c) => html`<td>${formatCell(row[c])}</td>`)}
            </tr>`;
          })}
        </tbody>
      </table>
    `;
  }

  private renderEmpty(title: string, hint: string): TemplateResult {
    return html`
      <div class="dv-empty">
        <svg class="pv-empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25">
          <rect x="4" y="4" width="16" height="16" rx="1.5"/>
          <line x1="4" y1="9.5" x2="20" y2="9.5"/>
          <line x1="9.5" y1="9.5" x2="9.5" y2="20"/>
        </svg>
        <div class="pv-empty-title">${title}</div>
        <div class="pv-empty-hint">${hint}</div>
      </div>
    `;
  }
}

customElements.define("chronos-data-viewer", ChronosDataViewer);

declare global {
  interface HTMLElementTagNameMap {
    "chronos-data-viewer": ChronosDataViewer;
  }
}
