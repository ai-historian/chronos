// Center-pane tab state (pure; shared by the renderer and unit tests).
// "page" and "data" are permanent; editor/image tabs are keyed by their file path.

export type TabKind = "page" | "data" | "editor" | "image";

export type Tab = {
  id: string;
  kind: TabKind;
  path?: string;
  title: string;
  dirty: boolean;
  mtimeMs?: number;
};

export type CloseResult = "closed" | "needs-confirm" | "not-closable";

const PERMANENT = new Set(["page", "data"]);

export class TabsModel {
  readonly tabs: Tab[];
  activeId: string;

  constructor() {
    this.tabs = [
      { id: "page", kind: "page", title: "Page", dirty: false },
      { id: "data", kind: "data", title: "Data", dirty: false },
    ];
    this.activeId = "page";
  }

  get active(): Tab {
    return this.get(this.activeId) ?? this.tabs[0];
  }

  get(id: string): Tab | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  /** Focus the tab already showing `tab.path`, else append a new one (id = path) and focus it. */
  open(tab: Omit<Tab, "id" | "dirty"> & { id?: string }): Tab {
    const existing = tab.path !== undefined ? this.tabs.find((t) => t.path === tab.path) : undefined;
    if (existing) {
      this.activeId = existing.id;
      return existing;
    }
    const id = tab.id ?? tab.path ?? `${tab.kind}:${this.tabs.length}`;
    const created: Tab = { ...tab, id, dirty: false };
    this.tabs.push(created);
    this.activeId = id;
    return created;
  }

  close(id: string): CloseResult {
    if (PERMANENT.has(id)) return "not-closable";
    const tab = this.get(id);
    if (!tab) return "closed";
    if (tab.dirty) return "needs-confirm";
    this.forceClose(id);
    return "closed";
  }

  /** Close regardless of dirty state; if it was active, activate its right (else left) neighbour. */
  forceClose(id: string): void {
    if (PERMANENT.has(id)) return;
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    if (this.activeId === id) this.activeId = (this.tabs[i] ?? this.tabs[i - 1] ?? this.tabs[0]).id;
  }

  activate(id: string): void {
    if (this.get(id)) this.activeId = id;
  }

  markDirty(id: string, dirty: boolean): void {
    const tab = this.get(id);
    if (tab) tab.dirty = dirty;
  }

  setMtime(id: string, mtimeMs: number): void {
    const tab = this.get(id);
    if (tab) tab.mtimeMs = mtimeMs;
  }
}
