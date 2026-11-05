// Main-side handling of the workspace file tree: listings, watching expanded dirs, and file actions.
import { statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { isAllowedPath } from "./protocol-handler";
import { DirWatcher, listDir, type DirChange, type TreeEntry } from "./files";
import type { Transport } from "./transport";
import type { WebviewToExt } from "../shared/webview-protocol";

export interface TreeHostOs {
  openPath(path: string): void;
  showItemInFolder(path: string): void;
  copyText(text: string): void;
}

export interface TreeHostOptions {
  root: string;
  transport: Transport;
  /** Open a source page in the viewer (AgentHost.showPageById). */
  showPage?: (sourceName: string, pageId: number) => void;
  /** OS integration; defaults to Electron's shell/clipboard (required lazily). */
  os?: TreeHostOs;
}

const PAGE_FILE = /^page_(\d+)\.(png|jpe?g)$/i;

function electronOs(): TreeHostOs {
  const { shell, clipboard } = require("electron") as typeof import("electron");
  return {
    openPath: (p) => void shell.openPath(p),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    copyText: (t) => clipboard.writeText(t),
  };
}

export class TreeHost {
  private readonly root: string;
  private readonly watcher: DirWatcher;
  /** Dirs the renderer has expanded (and we watch), root included. */
  private readonly open = new Set<string>();
  private os: TreeHostOs | undefined;

  constructor(private readonly opts: TreeHostOptions) {
    this.root = resolve(opts.root);
    this.os = opts.os;
    this.watcher = new DirWatcher(this.root, (e) => this.onFsChange(e));
  }

  start(): void {
    this.postRoot();
    this.open.add(this.root);
    this.watcher.watch(this.root);
  }

  stop(): void {
    this.watcher.close();
    this.open.clear();
  }

  /** Returns true if the message is a tree/file message (consumed, even when rejected). */
  handle(msg: WebviewToExt): boolean {
    switch (msg.type) {
      case "tree/expand": {
        const p = this.validate(msg.path);
        if (p && this.isDir(p)) {
          this.postChildren(p);
          this.open.add(p);
          this.watcher.watch(p);
        }
        return true;
      }
      case "tree/collapse": {
        const p = this.validate(msg.path);
        if (p && p !== this.root) {
          this.open.delete(p);
          this.watcher.unwatch(p);
        }
        return true;
      }
      case "tree/refresh":
        this.postRoot();
        for (const dir of [...this.open]) {
          if (dir === this.root) continue;
          if (this.isDir(dir)) this.postChildren(dir);
          else this.forget(dir);
        }
        return true;
      case "file/open": {
        const p = this.validate(msg.path);
        if (p) this.openFile(p);
        return true;
      }
      case "file/revealInOs": {
        const p = this.validate(msg.path);
        if (p) this.osApi().showItemInFolder(p);
        return true;
      }
      case "file/copyPath": {
        const p = this.validate(msg.path);
        if (p) this.osApi().copyText(p);
        return true;
      }
      default:
        return false;
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Absolute path inside the workspace and not under a hidden (dot) segment, else null. */
  private validate(path: unknown): string | null {
    if (typeof path !== "string" || path.length === 0) return null;
    const abs = resolve(path);
    if (!isAllowedPath(this.root, abs)) return null;
    const rel = relative(this.root, abs);
    if (rel && rel.split(sep).some((seg) => seg.startsWith("."))) return null;
    return abs;
  }

  private osApi(): TreeHostOs {
    return (this.os ??= electronOs());
  }

  private isDir(p: string): boolean {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  private openFile(p: string): void {
    const segs = relative(this.root, p).split(sep);
    const m = PAGE_FILE.exec(segs[segs.length - 1] ?? "");
    // <root>/sources/<source...>/png/page_NNNN.png → viewer
    if (m && segs.length >= 4 && segs[0] === "sources" && segs[segs.length - 2] === "png" && this.opts.showPage) {
      this.opts.showPage(segs.slice(1, -2).join("/"), parseInt(m[1], 10));
      return;
    }
    this.osApi().openPath(p);
  }

  private postRoot(): void {
    let entries: TreeEntry[] = [];
    try {
      entries = listDir(this.root, this.root);
    } catch {
      // workspace unreadable: show it empty
    }
    this.opts.transport.post({ type: "tree", root: this.root, entries });
  }

  private postChildren(dir: string): void {
    try {
      this.opts.transport.post({ type: "tree/children", path: dir, entries: listDir(dir, this.root) });
    } catch {
      // vanished between check and list; the parent's watcher reports the unlink
    }
  }

  private forget(dir: string): void {
    for (const d of [...this.open]) {
      if (d === dir || d.startsWith(dir + sep)) {
        this.open.delete(d);
        this.watcher.unwatch(d);
      }
    }
  }

  private onFsChange(e: DirChange): void {
    if (e.kind === "unlink") this.forget(e.path);
    let entry: TreeEntry | undefined;
    if (e.kind === "add") {
      try {
        const st = statSync(e.path);
        const name = e.path.slice(e.path.lastIndexOf(sep) + 1);
        entry = st.isDirectory() ? { path: e.path, name, kind: "dir" } : { path: e.path, name, kind: "file", size: st.size };
      } catch {
        return; // gone again already
      }
    }
    this.opts.transport.post({ type: "tree/changed", path: e.path, kind: e.kind, ...(entry ? { entry } : {}) });
  }
}
