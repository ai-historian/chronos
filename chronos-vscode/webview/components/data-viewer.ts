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

// Width-map key for the provenance action column (it has no column name of its
// own). Namespaced so it can't collide with a real data column.
const PROV_COL = "__chronos_prov__";
const MIN_COL_WIDTH = 48;
// Upper bound for double-click auto-fit; matches the cell max-width cap so a
// column with one very long entry doesn't blow out the whole table.
const MAX_COL_WIDTH = 360;

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
  | { kind: "table"; columns: string[]; rows: Row[]; provenance: Provenance[][] }
  | { kind: "text"; text: string };

// Coerce a single chronos_bbox value ([x,y,w,h] or {x,y,w,h}) to a Bbox, else null.
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

// Normalize a scalar-or-list value to a list. A bare scalar becomes a single
// element; null/undefined becomes empty. (Bbox needs special handling — a single
// bbox is itself an array of 4 — so it is not routed through here.)
function toList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// Length-preserving: invalid entries become NaN rather than being dropped, so a
// hole in chronos_page doesn't shift the index alignment with bbox/source. The
// NaN slot is skipped per-index in rowProvenance.
function pageList(value: unknown): number[] {
  return toList(value).map((v) => (typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN));
}

function sourceList(value: unknown): (string | undefined)[] {
  return toList(value).map((v) => (typeof v === "string" ? v : undefined));
}

// chronos_bbox may be a single bbox ({x,y,w,h} or [x,y,w,h]) or a list of them.
function bboxList(value: unknown): (Bbox | null)[] {
  if (value === undefined || value === null) return [];
  const single = toBbox(value);
  if (single) return [single];
  if (Array.isArray(value)) {
    // A flat array of bare numbers is one (malformed, non-4-tuple) bbox, not a
    // parallel list — collapse it to a single null so it doesn't inflate the
    // reference count. Only map element-wise for a real list (nested arrays/objects).
    if (value.every((el) => typeof el === "number")) return [null];
    return value.map(toBbox);
  }
  return [];
}

// A row may cite several (source, page, bbox) locations via list-valued reserved
// keys; a scalar is treated as a single-element list (backward compatible). Lists
// align by index; a length-1 list broadcasts (e.g. one source shared across pages,
// or several bboxes on a single page). A reference must resolve to a page id.
function rowProvenance(row: Row): Provenance[] {
  const pages = pageList(row[RESERVED.page]);
  const bboxes = bboxList(row[RESERVED.bbox]);
  const sources = sourceList(row[RESERVED.source]);
  const count = Math.max(pages.length, bboxes.length, sources.length);
  const at = <T,>(list: T[], i: number): T | undefined => (list.length === 1 ? list[0] : list[i]);
  // A single bbox broadcasts across several regions of ONE page (pages.length===1),
  // but not across distinct pages — that region was measured on one page only, so
  // applying it to the others would mis-crop them. Drop the bbox in that case.
  const multiPage = pages.length > 1;

  const refs: Provenance[] = [];
  for (let i = 0; i < count; i++) {
    const pageId = at(pages, i);
    // Skip just this slot when the page is missing/invalid — keep every other
    // reference aligned with its own bbox/source (don't shift the rest).
    if (pageId === undefined || Number.isNaN(pageId)) continue;
    const bbox = bboxes.length === 1 && multiPage ? null : at(bboxes, i) ?? null;
    refs.push({ pageId, bbox, sourcePath: at(sources, i) ?? undefined });
  }
  return refs;
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
    colWidths: { state: true },
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
  // Per-column pixel widths once the user has dragged a resize handle. Empty
  // until first resize, when every column is seeded from its rendered width.
  declare colWidths: Record<string, number>;

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
    this.colWidths = {};
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
    this.pruneColWidths(content);
  }

  // A Refresh reloads the same file in place, and the agent may rewrite an
  // extraction output with added/removed/renamed columns. Drop width keys that
  // no longer match a live column so a schema change doesn't leave orphan keys or
  // (via the `resized` every-column guard) silently revert the table to auto
  // layout on a column that merely changed name.
  private pruneColWidths(content: string): void {
    if (Object.keys(this.colWidths).length === 0) return;
    const parsed = this.parse(content);
    if (parsed.kind !== "table") {
      this.colWidths = {};
      return;
    }
    const allowed = new Set<string>([...parsed.columns, PROV_COL]);
    const next: Record<string, number> = {};
    for (const [k, v] of Object.entries(this.colWidths)) {
      if (allowed.has(k)) next[k] = v;
    }
    this.colWidths = next;
  }

  /** Reset to the empty state (no source bound) — e.g. when a new session starts. */
  clearSource(): void {
    this.sourceName = "";
    this.files = [];
    this.selected = null;
    this.content = null;
    this.loading = false;
    this.preview = null;
    this.colWidths = {};
  }

  private selectFile(filename: string | null): void {
    this.selected = filename;
    this.content = null;
    this.sortColumn = null;
    this.preview = null;
    this.colWidths = {};
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

  private sortRows(parsed: Extract<Parsed, { kind: "table" }>): { rows: Row[]; provenance: Provenance[][] } {
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

  // Drag a header's right-edge handle to resize that column. The first drag
  // seeds every column's current rendered width and flips the table to fixed
  // layout, so untouched columns stay put and the table can grow past the
  // viewport (the scroll container then scrolls horizontally).
  private onColResizeDown(e: PointerEvent, column: string): void {
    e.preventDefault();
    e.stopPropagation(); // don't trigger the header's sort click
    const table = this.querySelector<HTMLTableElement>(".dv-table");
    if (!table) return;
    const widths = this.seedWidths(table);
    const startX = e.clientX;
    const startW = widths[column] ?? MIN_COL_WIDTH;
    // Capture the pointer on the handle so the drag keeps tracking — and its
    // teardown always fires — even when the pointer leaves the webview and the
    // button is released outside it. A window-level pointerup is missed in that
    // case, which would leak the move listener and glue the column to the cursor.
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(MIN_COL_WIDTH, Math.round(startW + (ev.clientX - startX)));
      this.colWidths = { ...this.colWidths, [column]: w };
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("lostpointercapture", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("lostpointercapture", onUp); // also covers pointercancel
  }

  // Double-click the handle to auto-fit the column to its widest cell, capped at
  // MAX_COL_WIDTH (a longer single entry then wraps within that width).
  private onColResizeDblClick(e: MouseEvent, column: string): void {
    e.preventDefault();
    e.stopPropagation();
    const table = this.querySelector<HTMLTableElement>(".dv-table");
    const th = (e.currentTarget as HTMLElement).closest("th") as HTMLTableCellElement | null;
    if (!table || !th) return;
    this.seedWidths(table); // lock the other columns before we change this one
    const fit = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, this.measureColumnFit(table, th)));
    this.colWidths = { ...this.colWidths, [column]: fit };
  }

  // On first interaction, capture every column's current rendered width so the
  // table can flip to fixed layout without the untouched columns shifting.
  private seedWidths(table: HTMLTableElement): Record<string, number> {
    if (Object.keys(this.colWidths).length > 0) return this.colWidths;
    const seeded: Record<string, number> = {};
    table.querySelectorAll<HTMLElement>("thead th[data-col]").forEach((th) => {
      const c = th.dataset.col;
      if (c) seeded[c] = th.getBoundingClientRect().width;
    });
    this.colWidths = seeded;
    return seeded;
  }

  // Widest of the header label and every body cell in this column, measured
  // single-line via canvas (layout-independent), plus cell padding.
  private measureColumnFit(table: HTMLTableElement, th: HTMLTableCellElement): number {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return MIN_COL_WIDTH;
    const fontOf = (el: Element | null): string => {
      const cs = getComputedStyle(el ?? th);
      return `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    };
    const idx = th.cellIndex;
    const label = th.querySelector(".dv-col-label");
    ctx.font = fontOf(label);
    let max = ctx.measureText(label?.textContent ?? "").width;
    const body = table.tBodies[0];
    if (body) {
      ctx.font = fontOf(body.rows[0]?.cells[idx] ?? null);
      for (const row of Array.from(body.rows)) {
        const text = row.cells[idx]?.textContent ?? "";
        const w = ctx.measureText(text).width;
        if (w > max) max = w;
      }
    }
    return Math.round(max + 20 /* 10px padding each side */ + 2 /* anti-ellipsis slack */);
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
    // Drop a preview that resolved after the source was cleared (e.g. a new
    // session cleared us while this request was in flight) — clearSource() sets
    // sourceName to "", so an empty source means nothing should be shown.
    if (!this.sourceName) return;
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
    const refs = parsed.provenance.find((r) => r.length > 0);
    if (refs && refs[0]) this.viewSource(refs[0]);
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
    provenanceCounts: number[];
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
      hasProvenance: parsed?.kind === "table" ? parsed.provenance.some((r) => r.length > 0) : false,
      provenanceCounts: parsed?.kind === "table" ? parsed.provenance.map((r) => r.length) : [],
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
    // Capture on the splitter so a pointerup outside the webview still tears the
    // listeners down (a missed window pointerup would leak the move handler).
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      // Preview is docked at the bottom: its height is from the pointer to the foot.
      this.previewPct = Math.max(15, Math.min(70, ((rect.bottom - ev.clientY) / rect.height) * 100));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("lostpointercapture", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("lostpointercapture", onUp); // also covers pointercancel
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
    const hasProvenance = provenance.some((refs) => refs.length > 0);
    // Only switch to fixed layout once every visible column has a recorded width
    // — otherwise a column without a width would collapse under fixed layout.
    const resized =
      Object.keys(this.colWidths).length > 0 &&
      parsed.columns.every((c) => this.colWidths[c] != null) &&
      (!hasProvenance || this.colWidths[PROV_COL] != null);
    const widthStyle = (c: string): string | undefined =>
      resized && this.colWidths[c] != null ? `width:${this.colWidths[c]}px` : undefined;
    return html`
      <table class="dv-table ${resized ? "is-resized" : ""}">
        <thead>
          <tr>
            ${hasProvenance
              ? html`<th class="dv-prov-head" data-col=${PROV_COL} style=${widthStyle(PROV_COL)} title="Jump to source page">⤢</th>`
              : nothing}
            ${parsed.columns.map(
              (c) => html`<th
                data-col=${c}
                style=${widthStyle(c)}
                @click=${() => this.toggleSort(c)}
                class=${this.sortColumn === c ? "is-sorted" : ""}
              >
                <span class="dv-col-label"
                  >${c}${this.sortColumn === c ? html`<span class="dv-sort">${this.sortDir === 1 ? "▲" : "▼"}</span>` : nothing}</span
                >
                <span
                  class="dv-resize"
                  title="Drag to resize · double-click to fit"
                  @pointerdown=${(e: PointerEvent) => this.onColResizeDown(e, c)}
                  @dblclick=${(e: MouseEvent) => this.onColResizeDblClick(e, c)}
                  @click=${(e: Event) => e.stopPropagation()}
                ></span>
              </th>`,
            )}
          </tr>
        </thead>
        <tbody>
          ${rows.map((row, i) => {
            const refs = provenance[i];
            return html`<tr>
              ${hasProvenance
                ? html`<td class="dv-prov">
                    <span class="dv-prov-list">
                      ${refs.map(
                        (prov) => html`<button
                          class="dv-view"
                          title="View source p.${prov.pageId}${prov.sourcePath ? ` · ${prov.sourcePath}` : ""}"
                          @click=${() => this.viewSource(prov)}
                        >
                          p.${prov.pageId}
                        </button>`,
                      )}
                    </span>
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
