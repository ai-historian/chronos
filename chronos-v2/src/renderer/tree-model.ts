// Pure workspace file-tree model (no DOM). Shared by the renderer (file-tree component) and
// main (compareEntries, so listDir and the model agree on ordering).

export interface TreeEntry {
  path: string;
  name: string;
  kind: "dir" | "file";
  size?: number;
}

export type TreeChangeKind = "add" | "unlink" | "change";

export interface TreeChange {
  path: string;
  kind: TreeChangeKind;
  /** For `add`: the stat-derived entry (main supplies it so a new dir shows as a dir). */
  entry?: TreeEntry;
}

export interface VisibleRow {
  entry: TreeEntry;
  depth: number;
  expanded: boolean;
  /** Children have been listed (always true for files). */
  loaded: boolean;
}

/** Directories first, then by name (locale-aware). */
export function compareEntries(a: TreeEntry, b: TreeEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** Parent of a main-produced absolute path (either separator). */
export function parentPath(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i <= 0 ? p.slice(0, i + 1) : p.slice(0, i);
}

function baseName(p: string): string {
  return p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
}

function isUnder(parent: string, p: string): boolean {
  return p.length > parent.length && p.startsWith(parent) && (p[parent.length] === "/" || p[parent.length] === "\\");
}

export class TreeModel {
  root = "";
  private children = new Map<string, TreeEntry[]>();
  private expanded = new Set<string>();

  setRoot(root: string, entries: TreeEntry[]): void {
    // A different workspace resets state; the first root keeps anything restored before it arrived.
    if (this.root && root !== this.root) {
      this.children.clear();
      this.expanded.clear();
    }
    this.root = root;
    // Expansion state restored from another workspace never applies here.
    for (const k of [...this.expanded]) if (!isUnder(root, k)) this.expanded.delete(k);
    this.children.set(root, [...entries].sort(compareEntries));
  }

  setChildren(path: string, entries: TreeEntry[]): void {
    const next = [...entries].sort(compareEntries);
    // Drop cached subtrees of children that no longer exist.
    const keep = new Set(next.map((e) => e.path));
    for (const old of this.children.get(path) ?? []) {
      if (!keep.has(old.path)) this.dropSubtree(old.path);
    }
    this.children.set(path, next);
  }

  toggle(path: string): "expanded" | "collapsed" {
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      return "collapsed";
    }
    this.expanded.add(path);
    return "expanded";
  }

  /** Force a dir open (e.g. when restoring saved expansion state). */
  expand(path: string): void {
    this.expanded.add(path);
  }

  isExpanded(path: string): boolean {
    return this.expanded.has(path);
  }

  isLoaded(path: string): boolean {
    return this.children.has(path);
  }

  /** Expanded dirs, root excluded (for persisting UI state). */
  expandedPaths(): string[] {
    return [...this.expanded];
  }

  entry(path: string): TreeEntry | undefined {
    return this.children.get(parentPath(path))?.find((e) => e.path === path);
  }

  applyChange(e: TreeChange): void {
    const parent = parentPath(e.path);
    const siblings = this.children.get(parent);
    if (e.kind === "add") {
      if (!siblings || siblings.some((s) => s.path === e.path)) return;
      const entry: TreeEntry = e.entry ?? { path: e.path, name: baseName(e.path), kind: "file" };
      const next = [...siblings];
      let i = next.findIndex((s) => compareEntries(entry, s) < 0);
      if (i < 0) i = next.length;
      next.splice(i, 0, entry);
      this.children.set(parent, next);
    } else if (e.kind === "unlink") {
      if (siblings) this.children.set(parent, siblings.filter((s) => s.path !== e.path));
      this.dropSubtree(e.path);
    }
    // "change": content changed; the tree shape is unaffected.
  }

  visible(): VisibleRow[] {
    const out: VisibleRow[] = [];
    const walk = (dir: string, depth: number) => {
      for (const entry of this.children.get(dir) ?? []) {
        const isDir = entry.kind === "dir";
        const expanded = isDir && this.expanded.has(entry.path);
        out.push({ entry, depth, expanded, loaded: !isDir || this.children.has(entry.path) });
        if (expanded) walk(entry.path, depth + 1);
      }
    };
    walk(this.root, 0);
    return out;
  }

  private dropSubtree(path: string): void {
    for (const k of [...this.children.keys()]) if (k === path || isUnder(path, k)) this.children.delete(k);
    for (const k of [...this.expanded]) if (k === path || isUnder(path, k)) this.expanded.delete(k);
  }
}
