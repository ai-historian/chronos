import { LitElement, html, nothing, svg, type TemplateResult } from "lit";
import type { WebviewToExt } from "../../shared/webview-protocol";
import { TreeModel, type TreeChange, type TreeEntry, type VisibleRow } from "../tree-model";

interface MenuState {
  x: number;
  y: number;
  entry: TreeEntry;
}


function chevron(): TemplateResult {
  return html`<svg class="ft-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${svg`<path d="m9 6 6 6-6 6" />`}
  </svg>`;
}

function folderIcon(open: boolean): TemplateResult {
  return html`<svg class="ft-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${open
      ? svg`<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h7A1.5 1.5 0 0 1 19 9.5V10H8.2a1.5 1.5 0 0 0-1.4 1L4 18.5" /><path d="M4 18.5 6.8 11a1.5 1.5 0 0 1 1.4-1H21l-2.9 7.6a1.5 1.5 0 0 1-1.4.9H4Z" />`
      : svg`<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z" />`}
  </svg>`;
}

function fileIcon(): TemplateResult {
  return html`<svg class="ft-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${svg`<path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5Z" /><path d="M14 3v4.5h4.5" />`}
  </svg>`;
}

function fmtSize(n: number | undefined): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Left-hand workspace file tree. Owns the TreeModel; the app forwards tree messages to it. */
export class ChronosFileTree extends LitElement {
  static properties = {
    currentSource: { type: String },
    rows: { state: true },
    selected: { state: true },
    menu: { state: true },
  };

  declare currentSource: string;
  declare rows: VisibleRow[];
  declare selected: string;
  declare menu: MenuState | null;

  private model = new TreeModel();
  private postMessage: (msg: WebviewToExt) => void = () => {};

  constructor() {
    super();
    this.currentSource = "";
    this.rows = [];
    this.selected = "";
    this.menu = null;
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  setPostMessage(fn: (msg: WebviewToExt) => void): void {
    this.postMessage = fn;
  }

  // ── host → tree ───────────────────────────────────────────────────────────

  setRoot(root: string, entries: TreeEntry[]): void {
    this.model.setRoot(root, entries);
    this.sync();
  }

  setChildren(path: string, entries: TreeEntry[]): void {
    this.model.setChildren(path, entries);
    this.sync();
  }

  applyChange(e: TreeChange): void {
    this.model.applyChange(e);
    this.sync();
  }

  /** Re-open dirs saved in UI state (main validates every path). */
  restoreExpanded(paths: string[]): void {
    for (const p of paths) {
      this.model.expand(p);
      this.postMessage({ type: "tree/expand", path: p });
    }
    this.sync();
  }

  expandedPaths(): string[] {
    return this.model.expandedPaths();
  }

  get root(): string {
    return this.model.root;
  }

  // ── actions ───────────────────────────────────────────────────────────────

  private sync(): void {
    this.rows = this.model.visible();
    if (this.selected && !this.rows.some((r) => r.entry.path === this.selected)) this.selected = "";
  }

  private changed(): void {
    this.dispatchEvent(new CustomEvent("ui-state-changed", { bubbles: true }));
  }

  private setExpanded(entry: TreeEntry, open: boolean): void {
    if (entry.kind !== "dir" || this.model.isExpanded(entry.path) === open) return;
    this.model.toggle(entry.path);
    // Expanding always re-lists: collapse stopped main watching the dir, so cached children may be stale.
    this.postMessage({ type: open ? "tree/expand" : "tree/collapse", path: entry.path });
    this.sync();
    this.changed();
  }

  private activate(entry: TreeEntry): void {
    this.selected = entry.path;
    if (entry.kind === "dir") this.setExpanded(entry, !this.model.isExpanded(entry.path));
    else this.postMessage({ type: "file/open", path: entry.path });
  }

  private sep(): string {
    const r = this.model.root;
    return r.includes("\\") && !r.includes("/") ? "\\" : "/";
  }

  private get sourcesPath(): string {
    return this.model.root ? this.model.root + this.sep() + "sources" : "";
  }

  private get activeSourcePath(): string {
    if (!this.currentSource || !this.model.root) return "";
    return this.sourcesPath + this.sep() + this.currentSource.split("/").join(this.sep());
  }

  private onKeydown(e: KeyboardEvent): void {
    if (this.menu) {
      if (e.key === "Escape") this.closeMenu();
      e.stopPropagation();
      return;
    }
    const rows = this.rows;
    if (!rows.length) return;
    let i = rows.findIndex((r) => r.entry.path === this.selected);
    const row = i >= 0 ? rows[i] : undefined;
    switch (e.key) {
      case "ArrowDown":
        i = Math.min(rows.length - 1, i + 1);
        break;
      case "ArrowUp":
        i = i < 0 ? 0 : Math.max(0, i - 1);
        break;
      case "ArrowRight":
        if (row) this.setExpanded(row.entry, true);
        break;
      case "ArrowLeft":
        if (row?.expanded) this.setExpanded(row.entry, false);
        else if (row) {
          // On a leaf / collapsed dir, Left moves to the parent row.
          for (let j = i - 1; j >= 0; j--) if (rows[j].depth < row.depth) { i = j; break; }
        }
        break;
      case "Enter":
        if (row) this.activate(row.entry);
        break;
      default:
        return; // let everything else (page shortcuts etc.) through
    }
    e.preventDefault();
    e.stopPropagation(); // don't also page the viewer
    if (i >= 0 && rows[i]) {
      this.selected = rows[i].entry.path;
      void this.updateComplete.then(() =>
        this.querySelector(`.ft-row[data-index="${i}"]`)?.scrollIntoView({ block: "nearest" }),
      );
    }
  }

  // ── context menu ──────────────────────────────────────────────────────────

  private readonly onOutsidePointer = (e: PointerEvent) => {
    if (!(e.target as Element | null)?.closest?.(".ft-menu")) this.closeMenu();
  };

  private readonly onWindowKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.closeMenu();
  };

  private openMenu(e: MouseEvent, entry: TreeEntry): void {
    e.preventDefault();
    this.selected = entry.path;
    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - 140);
    this.menu = { x: Math.max(0, x), y: Math.max(0, y), entry };
    window.addEventListener("pointerdown", this.onOutsidePointer, true);
    window.addEventListener("keydown", this.onWindowKey, true);
    window.addEventListener("blur", this.closeMenu);
  }

  private readonly closeMenu = () => {
    if (!this.menu) return;
    this.menu = null;
    window.removeEventListener("pointerdown", this.onOutsidePointer, true);
    window.removeEventListener("keydown", this.onWindowKey, true);
    window.removeEventListener("blur", this.closeMenu);
  };

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.closeMenu();
  }

  private menuAction(fn: () => void): void {
    this.closeMenu();
    fn();
  }

  private renderMenu(): TemplateResult {
    const { x, y, entry } = this.menu!;
    const item = (label: string, fn: () => void) =>
      html`<button class="ft-menu-item" role="menuitem" @click=${() => this.menuAction(fn)}>${label}</button>`;
    return html`
      <div class="ft-menu" role="menu" style="left:${x}px;top:${y}px" @contextmenu=${(e: Event) => e.preventDefault()}>
        ${item("Open", () => this.activate(entry))}
        ${item("Reveal in OS", () => this.postMessage({ type: "file/revealInOs", path: entry.path }))}
        ${item("Copy path", () => this.postMessage({ type: "file/copyPath", path: entry.path }))}
        ${entry.path === this.sourcesPath
          ? html`<div class="ft-menu-sep"></div>${item("Import sources…", () => this.postMessage({ type: "workspace/import" }))}`
          : nothing}
      </div>
    `;
  }

  // ── render ────────────────────────────────────────────────────────────────

  private renderRow(r: VisibleRow, index: number, activeSource: string): TemplateResult {
    const { entry, depth, expanded } = r;
    const isDir = entry.kind === "dir";
    const classes = [
      "ft-row",
      isDir ? "is-dir" : "is-file",
      entry.path === this.selected ? "is-selected" : "",
      entry.path === activeSource ? "is-active-source" : "",
      expanded ? "is-expanded" : "",
    ].join(" ");
    return html`
      <div
        class=${classes}
        role="treeitem"
        aria-level=${depth + 1}
        aria-expanded=${isDir ? String(expanded) : nothing}
        aria-selected=${String(entry.path === this.selected)}
        data-index=${index}
        style="padding-left:${6 + depth * 14}px"
        title=${isDir ? entry.path : `${entry.path} · ${fmtSize(entry.size)}`}
        @click=${() => this.activate(entry)}
        @contextmenu=${(e: MouseEvent) => this.openMenu(e, entry)}
      >
        <span class="ft-twisty">${isDir ? chevron() : nothing}</span>
        ${isDir ? folderIcon(expanded) : fileIcon()}
        <span class="ft-name">${entry.name}</span>
        ${entry.path === activeSource ? html`<span class="ft-source-dot" title="Current source"></span>` : nothing}
      </div>
    `;
  }

  render(): TemplateResult {
    const root = this.model.root;
    const title = root.split(/[\\/]/).filter(Boolean).pop() ?? "Workspace";
    const activeSource = this.activeSourcePath;
    return html`
      <div class="ft-header">
        <span class="ft-title" title=${root}>${title}</span>
        <button class="icon-btn ft-refresh" title="Refresh" aria-label="Refresh file tree" @click=${() => this.postMessage({ type: "tree/refresh" })}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            ${svg`<path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" />`}
          </svg>
        </button>
      </div>
      <div class="ft-list" role="tree" tabindex="0" aria-label="Workspace files" @keydown=${this.onKeydown}>
        ${this.rows.length === 0 ? html`<div class="ft-empty">${root ? "Empty workspace" : "Loading…"}</div>` : nothing}
        ${this.rows.map((r, i) => this.renderRow(r, i, activeSource))}
      </div>
      ${this.menu ? this.renderMenu() : nothing}
    `;
  }
}

customElements.define("chronos-file-tree", ChronosFileTree);

declare global {
  interface HTMLElementTagNameMap {
    "chronos-file-tree": ChronosFileTree;
  }
}
