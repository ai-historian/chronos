// Main-side handling of the workspace file tree: listings, watching expanded dirs, and file actions.
import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

/** Extensions shell.openPath would execute rather than open in a viewer app (any platform). */
export const LAUNCHABLE_EXTENSIONS: readonly string[] = [
  "exe", "bat", "cmd", "com", "ps1", "vbs", "js", "jse", "wsf", "wsh", "msi", "lnk", "scr", "pif",
  "app", "command", "sh", "bash", "zsh", "desktop", "appimage", "jar", "run",
];

/** True for files that opening would run: a launchable extension, or (POSIX) any exec bit. */
export function isLaunchable(path: string): boolean {
  const ext = extname(path).slice(1).toLowerCase();
  if (LAUNCHABLE_EXTENSIONS.includes(ext)) return true;
  if (process.platform === "win32") return false;
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return true; // can't tell: err on the side of not launching
  }
}

/** A renderer path after validation: `real` is used for all fs/OS access, `logical` keys the renderer's model. */
interface Checked {
  real: string;
  logical: string;
}

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
  /** realpath of root (root itself may sit behind a symlink, e.g. /tmp on macOS). */
  private readonly realRoot: string;
  private readonly watcher: DirWatcher;
  /** Dirs the renderer has expanded (and we watch), root included. */
  private readonly open = new Set<string>();
  private os: TreeHostOs | undefined;

  constructor(private readonly opts: TreeHostOptions) {
    this.root = resolve(opts.root);
    let realRoot = this.root;
    try {
      realRoot = realpathSync(this.root);
    } catch {
      // root missing: every validate() fails anyway
    }
    this.realRoot = realRoot;
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
        if (p && this.isDir(p.real)) {
          this.postChildren(p.logical, p.real);
          // Watch the logical path so change events carry the paths the renderer knows.
          this.open.add(p.logical);
          this.watcher.watch(p.logical);
        }
        return true;
      }
      case "tree/collapse": {
        const p = this.validate(msg.path);
        if (p && p.logical !== this.root) {
          this.open.delete(p.logical);
          this.watcher.unwatch(p.logical);
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
        if (p) this.openFile(p.real);
        return true;
      }
      case "file/revealInOs": {
        const p = this.validate(msg.path);
        if (p) this.osApi().showItemInFolder(p.real);
        return true;
      }
      case "file/copyPath": {
        const p = this.validate(msg.path);
        if (p) this.osApi().copyText(p.real);
        return true;
      }
      default:
        return false;
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Resolve a renderer path to its realpath and accept it only if that realpath lies inside the
   * workspace and has no hidden (dot) segment relative to it. Checking the realpath (not the
   * requested string) stops a symlink like `envlink -> .chronos/.env`, and callers use `real` so
   * the checked path and the used path cannot diverge. Non-existent paths are rejected.
   */
  private validate(path: unknown): Checked | null {
    if (typeof path !== "string" || path.length === 0) return null;
    const logical = resolve(path);
    let real: string;
    try {
      real = realpathSync(logical);
    } catch {
      return null;
    }
    if (!isAllowedPath(this.realRoot, real)) return null;
    const rel = relative(this.realRoot, real);
    if (rel && rel.split(sep).some((seg) => seg.startsWith("."))) return null;
    // The logical path must also stay inside the root with no dot segment (it keys the model).
    const relLogical = relative(this.root, logical);
    if (isAbsolute(relLogical) || relLogical.startsWith("..") || relLogical.split(sep).some((seg) => seg.startsWith("."))) return null;
    return { real, logical };
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
    const segs = relative(this.realRoot, p).split(sep);
    const m = PAGE_FILE.exec(segs[segs.length - 1] ?? "");
    // <root>/sources/<source...>/png/page_NNNN.png → viewer
    if (m && segs.length >= 4 && segs[0] === "sources" && segs[segs.length - 2] === "png" && this.opts.showPage) {
      this.opts.showPage(segs.slice(1, -2).join("/"), parseInt(m[1], 10));
      return;
    }
    if (isLaunchable(p)) {
      // openPath would execute it; reveal it instead.
      this.osApi().showItemInFolder(p);
      this.opts.transport.post({ type: "notify", level: "info", message: "Executable files are revealed, not launched" });
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

  /** List `real` (defaults to `dir`) and post it under the renderer-facing `dir`. */
  private postChildren(dir: string, real = dir): void {
    try {
      const entries = listDir(real, this.root).map((e) => (real === dir ? e : { ...e, path: join(dir, e.name) }));
      this.opts.transport.post({ type: "tree/children", path: dir, entries });
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
