// Workspace file listing + directory watching for the file tree (Electron-free).
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

/** Largest file the editor will load. */
export const MAX_TEXT_BYTES = 20 * 1024 * 1024;

export function statMtime(path: string): number {
  return statSync(path).mtimeMs;
}

/** Strict UTF-8 (BOM kept in the text so a save writes it back). Throws on invalid bytes. */
function decodeUtf8(buf: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
}

/**
 * Read a file for the editor; throws for files over 20 MB. Non-UTF-8 files (e.g. Windows-1252
 * CSVs) come back decoded as Latin-1 with `encoding: "unknown"` — callers must not save them,
 * since writing the text back as UTF-8 would change every non-ASCII byte.
 */
export function readText(path: string): { content: string; mtimeMs: number; encoding: "utf-8" | "unknown" } {
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`${basename(path)} is not a file`);
  if (st.size > MAX_TEXT_BYTES) throw new Error(`${basename(path)} is larger than 20 MB; open it in another app`);
  const buf = readFileSync(path);
  try {
    return { content: decodeUtf8(buf), mtimeMs: st.mtimeMs, encoding: "utf-8" };
  } catch {
    return { content: buf.toString("latin1"), mtimeMs: st.mtimeMs, encoding: "unknown" };
  }
}

/** True if the file is valid UTF-8 (or does not exist); false for other encodings or unreadable files. */
export function isUtf8File(path: string): boolean {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    decodeUtf8(buf);
    return true;
  } catch {
    return false;
  }
}

export type WriteResult = { ok: true; mtimeMs: number } | { ok: false; error: "changed-on-disk" | string };

/**
 * Write `content` atomically (temp file in the same dir + rename), keeping the file's mode.
 * With `expectedMtimeMs` (and not -1), refuse with `changed-on-disk` when the file's current
 * mtime differs — someone (usually the agent) rewrote it since the editor loaded it.
 */
export function writeText(path: string, content: string, expectedMtimeMs?: number): WriteResult {
  let mode: number | undefined;
  try {
    const st = statSync(path);
    mode = st.mode & 0o7777;
    if (expectedMtimeMs !== undefined && expectedMtimeMs !== -1 && st.mtimeMs !== expectedMtimeMs) {
      return { ok: false, error: "changed-on-disk" };
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, error: (e as Error).message };
  }
  // Dot-prefixed so the file-tree watcher ignores the temp file.
  const tmp = join(dirname(path), `.${basename(path)}.chronos-${process.pid}-${Date.now().toString(36)}.tmp`);
  try {
    writeFileSync(tmp, content, "utf8");
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
    return { ok: true, mtimeMs: statSync(path).mtimeMs };
  } catch (e) {
    rmSync(tmp, { force: true });
    return { ok: false, error: (e as Error).message };
  }
}
