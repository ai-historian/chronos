// Workspace file listing + directory watching for the file tree (Electron-free).
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { isAllowedPath } from "./protocol-handler";
import { compareEntries, type TreeEntry, type TreeChangeKind } from "../renderer/tree-model";

export type { TreeEntry };

/** List one directory level: dot-names hidden, dirs first then locale order. Throws outside `root`. */
export function listDir(dir: string, root: string): TreeEntry[] {
  const abs = resolve(dir);
  if (!isAllowedPath(root, abs)) throw new Error(`listDir: ${dir} is outside the workspace`);
  const out: TreeEntry[] = [];
  for (const name of readdirSync(abs)) {
    if (name.startsWith(".")) continue;
    const path = join(abs, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue; // dangling symlink / vanished meanwhile
    }
    if (st.isDirectory()) out.push({ path, name, kind: "dir" });
    else out.push({ path, name, kind: "file", size: st.size });
  }
  return out.sort(compareEntries);
}

export interface DirChange {
  path: string;
  kind: TreeChangeKind;
}

const DEBOUNCE_MS = 300;

/** One non-recursive fs.watch per watched dir; per-path 300 ms debounce; dot-names ignored. */
export class DirWatcher {
  private watchers = new Map<string, FSWatcher>();
  private pending = new Map<string, { timer: NodeJS.Timeout; renamed: boolean }>();

  constructor(
    private readonly root: string,
    private readonly onChange: (e: DirChange) => void,
  ) {}

  watch(dir: string): void {
    const abs = resolve(dir);
    if (this.watchers.has(abs) || !isAllowedPath(this.root, abs)) return;
    let w: FSWatcher;
    try {
      w = watch(abs, { persistent: false }, (eventType, filename) => {
        if (!filename) return;
        const name = filename.toString();
        if (name.startsWith(".")) return;
        this.queue(join(abs, name), eventType === "rename");
      });
    } catch {
      return; // dir vanished or unwatchable: the tree just won't live-update it
    }
    w.on("error", () => this.unwatch(abs));
    this.watchers.set(abs, w);
  }

  unwatch(dir: string): void {
    const abs = resolve(dir);
    this.watchers.get(abs)?.close();
    this.watchers.delete(abs);
  }

  close(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  private queue(path: string, renamed: boolean): void {
    const prev = this.pending.get(path);
    if (prev) clearTimeout(prev.timer);
    const entry = {
      renamed: renamed || !!prev?.renamed,
      timer: setTimeout(() => {
        this.pending.delete(path);
        const kind: TreeChangeKind = entry.renamed ? (existsSync(path) ? "add" : "unlink") : "change";
        this.onChange({ path, kind });
      }, DEBOUNCE_MS),
    };
    this.pending.set(path, entry);
  }
}
