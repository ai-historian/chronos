// Source import pipeline: PDFs / images / text files -> <sourcesDir>/<name>/png/page_NNNN.png.
// Moved from chronos-vscode/src/extension.ts (importFile & co.) with the VS Code UI calls
// replaced by a ProgressSink callback and returned results. Electron-free.
import { readdirSync, statSync, existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync, renameSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { Worker } from "node:worker_threads";
import { withPdfDocument } from "./pdf-stream";
import {
  readImportMarker,
  writeImportMarker,
  updateImportMarker,
  clearImportMarker,
  partialPngDir,
  countPartialPages,
  finalizePartialImport,
  type IncompleteImport,
} from "./import-status";

export { findIncompleteImports, type IncompleteImport } from "./import-status";

export const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"]);
export const SUPPORTED_EXTS = new Set([...IMAGE_EXTS, ".pdf", ".txt"]);

export type ProgressSink = (p: {
  id: string;
  title: string;
  done: number;
  total?: number;
  message?: string;
  finished?: boolean;
}) => void;

export interface ImportResult {
  imported: number;
  skipped: string[];
  errors: string[];
}

/** Worker script paths (esbuild emits them beside main.js). */
export interface ImportWorkers {
  pdf: string;
  split: string;
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

// The bundled mupdf is a 32-bit (wasm32) WASM build: its file offsets are capped at 2^31,
// so it cannot open PDFs >= 2 GiB (their xref/objects live past that offset). Such files are
// first split into <2 GiB parts with pdf-lib (pure JS, 64-bit offsets) — see splitLargePdf.
const MAX_WASM_PDF_BYTES = 2 ** 31;

// Render every page of a (<2 GiB) PDF to PNGs via a pool of worker threads. pageOffset is
// added to each page index for naming, so split parts produce globally-numbered pages.
export async function renderPdfFile(
  workerScript: string,
  filePath: string,
  pngDir: string,
  totalPages: number,
  pageOffset: number,
  onProgress: (completedInFile: number) => void,
): Promise<void> {
  const POOL_SIZE = 4;
  const BATCH_SIZE = 50;
  let completed = 0;

  const batches: { start: number; end: number }[] = [];
  for (let i = 0; i < totalPages; i += BATCH_SIZE) {
    batches.push({ start: i, end: Math.min(i + BATCH_SIZE, totalPages) });
  }

  let batchIdx = 0;
  // On the first failure the remaining workers are terminated (below); `failed` stops any
  // late messages from reporting progress and keeps new batches from being started.
  let failed = false;
  const live = new Set<Worker>();
  const runNext = (): Promise<void> => {
    const idx = batchIdx++;
    if (failed || idx >= batches.length) return Promise.resolve();
    const { start, end } = batches[idx];
    return new Promise<void>((resolve, reject) => {
      const w = new Worker(workerScript, {
        workerData: { filePath, pngDir, startPage: start, endPage: end, pageOffset, dpi: 200 },
      });
      live.add(w);
      w.once("exit", () => live.delete(w));
      let workerError = "";
      w.on("message", (msg: { type: string; page?: number; message?: string }) => {
        if (failed) return;
        if (msg.type === "progress") {
          completed++;
          onProgress(completed);
        } else if (msg.type === "error") {
          workerError = msg.message ?? "unknown error";
        }
      });
      w.on("error", reject);
      w.on("exit", (code) => {
        if (code !== 0) {
          reject(new Error(workerError || `Worker exited with code ${code}`));
        } else {
          resolve();
        }
      });
    }).then(() => runNext());
  };

  try {
    await Promise.all(Array.from({ length: Math.min(POOL_SIZE, batches.length) }, () => runNext()));
  } catch (err) {
    // Promise.all rejects on the first failure while siblings keep running; stop them so they
    // neither report progress after the import has ended nor keep writing into png.partial.
    failed = true;
    await Promise.allSettled([...live].map((w) => w.terminate()));
    throw err;
  }
}

// Split a >= 2 GiB PDF into <2 GiB part files (in outDir) using a pdf-lib worker thread, so
// the heavy parse runs off the main event loop and in its own heap. Returns the parts
// (with their global page offsets) in reading order.
function splitLargePdf(
  workerScript: string,
  filePath: string,
  outDir: string,
  onProgress: (message: string) => void,
): Promise<{ chunks: { path: string; pageOffset: number; pageCount: number }[]; totalPages: number }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerScript, {
      workerData: { filePath, outDir, targetChunkBytes: 2 ** 30 }, // ~1 GiB parts (safely < 2 GiB)
      resourceLimits: { maxOldGenerationSizeMb: 8192 }, // headroom for pdf-lib on multi-GiB files
    });
    let result: { chunks: { path: string; pageOffset: number; pageCount: number }[]; totalPages: number } | null = null;
    let workerError = "";
    w.on("message", (msg: { type: string; message?: string; chunks?: any[]; totalPages?: number }) => {
      if (msg.type === "progress") {
        onProgress(msg.message ?? "");
      } else if (msg.type === "done") {
        result = { chunks: msg.chunks ?? [], totalPages: msg.totalPages ?? 0 };
      } else if (msg.type === "error") {
        workerError = msg.message ?? "unknown error";
      }
    });
    w.on("error", reject);
    w.on("exit", (code) => {
      if (code !== 0 || !result) {
        reject(new Error(workerError || `Split worker exited with code ${code}`));
      } else {
        resolve(result);
      }
    });
  });
}

/** Per-file progress: a message, plus page counts once they are known. */
type FileProgress = (msg: string, pages?: { done: number; total: number }) => void;

type FileResult = { ok: true } | { ok: false; kind: "unsupported" | "exists" | "error"; error: string };

async function importFile(
  filePath: string,
  sourcesDir: string,
  workers: ImportWorkers,
  progress: FileProgress,
): Promise<FileResult> {
  const ext = extname(filePath).toLowerCase();
  const sourceName = stripExt(basename(filePath));
  const sourceDir = join(sourcesDir, sourceName);
  const marker = readImportMarker(sourceDir);

  if (!SUPPORTED_EXTS.has(ext)) {
    return { ok: false, kind: "unsupported", error: `Unsupported file type: ${ext}` };
  }
  // A finished png-based source has png/. If a marker also lingers (crash between the
  // png.partial->png rename and clearing the marker) the import is in fact done — drop the
  // stray marker and treat it as complete.
  if (existsSync(join(sourceDir, "png"))) {
    if (marker) clearImportMarker(sourceDir);
    return { ok: false, kind: "exists", error: `Source "${sourceName}" already exists, skipping` };
  }
  // No png/ yet: a leftover marker means an interrupted import to resume; otherwise any other
  // existing dir (e.g. a .txt source, or something the user placed) must not be clobbered.
  const resuming = marker !== null;
  if (!resuming && existsSync(sourceDir)) {
    return { ok: false, kind: "exists", error: `Source "${sourceName}" already exists, skipping` };
  }

  mkdirSync(sourceDir, { recursive: true });
  // Record (or keep) the in-progress marker; cleared only once the import completes.
  if (!resuming) {
    writeImportMarker(sourceDir, { source: sourceName, sourceFile: filePath, dpi: 200, startedAt: new Date().toISOString() });
  }

  try {
    if (ext === ".pdf") {
      const pngPartial = partialPngDir(sourceDir);
      mkdirSync(pngPartial, { recursive: true });
      const workerScript = workers.pdf;
      progress(`Converting PDF: ${sourceName}${resuming ? " (resuming)" : ""}...`);
      const mupdf = await import("mupdf");

      if (statSync(filePath).size >= MAX_WASM_PDF_BYTES) {
        // mupdf's WASM build can't open files >= 2 GiB (32-bit offsets). Split into
        // <2 GiB parts with pdf-lib (pure JS, 64-bit offsets), then render each part with
        // the normal mupdf worker pool, numbering pages globally via each part's offset.
        const gib = (statSync(filePath).size / 2 ** 30).toFixed(1);
        // Already fully rendered but interrupted before finalize? Clean any leftover parts
        // and finalize.
        if (marker?.expectedPages && countPartialPages(sourceDir) >= marker.expectedPages) {
          rmSync(join(sourceDir, ".parts"), { recursive: true, force: true });
          finalizePartialImport(sourceDir);
          return { ok: true };
        }
        progress(`Converting PDF: ${sourceName} (${gib} GiB — splitting into parts)...`);
        const splitDir = join(sourceDir, ".parts");
        mkdirSync(splitDir, { recursive: true });
        try {
          const { chunks, totalPages } = await splitLargePdf(workers.split, filePath, splitDir, (msg) =>
            progress(`Converting PDF: ${sourceName} (${msg})...`),
          );
          updateImportMarker(sourceDir, { expectedPages: totalPages });
          let done = 0;
          for (const chunk of chunks) {
            await renderPdfFile(workerScript, chunk.path, pngPartial, chunk.pageCount, chunk.pageOffset, (completed) =>
              progress(`Converting PDF: ${sourceName} (${done + completed}/${totalPages} pages)...`, {
                done: done + completed,
                total: totalPages,
              }),
            );
            done += chunk.pageCount;
            rmSync(chunk.path, { force: true }); // free the part's disk before rendering the next
          }
        } finally {
          rmSync(splitDir, { recursive: true, force: true });
        }
        finalizePartialImport(sourceDir);
        return { ok: true };
      }

      // < 2 GiB: open through a seekable file stream (see withPdfDocument) so mupdf reads
      // pages on demand instead of slurping the file into memory.
      const totalPages = withPdfDocument(mupdf, filePath, (doc) => doc.countPages());
      updateImportMarker(sourceDir, { expectedPages: totalPages });

      if (totalPages <= 1) {
        // Render directly — no worker overhead
        const dpi = 200;
        const scale = dpi / 72;
        withPdfDocument(mupdf, filePath, (doc) => {
          for (let i = 0; i < totalPages; i++) {
            const target = join(pngPartial, `page_${String(i + 1).padStart(4, "0")}.png`);
            if (existsSync(target)) continue;
            const page = doc.loadPage(i);
            const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
            writeFileSync(target + ".tmp", pixmap.asPNG());
            renameSync(target + ".tmp", target);
            pixmap.destroy();
            page.destroy();
          }
        });
        progress(`Converting PDF: ${sourceName}`, { done: totalPages, total: totalPages });
      } else {
        progress(`Converting PDF: ${sourceName} (${totalPages} pages)...`, { done: 0, total: totalPages });
        await renderPdfFile(workerScript, filePath, pngPartial, totalPages, 0, (completed) =>
          progress(`Converting PDF: ${sourceName} (${completed}/${totalPages} pages)...`, { done: completed, total: totalPages }),
        );
      }

      finalizePartialImport(sourceDir);
      return { ok: true };
    }

    if (IMAGE_EXTS.has(ext)) {
      const pngPartial = partialPngDir(sourceDir);
      mkdirSync(pngPartial, { recursive: true });
      progress(`Importing image: ${sourceName}`);
      updateImportMarker(sourceDir, { expectedPages: 1 });
      copyFileSync(filePath, join(pngPartial, `page_0001${ext}`));
      finalizePartialImport(sourceDir);
      return { ok: true };
    }

    // .txt: the file itself is the source content (no png/); marker cleared on success.
    progress(`Importing text: ${sourceName}`);
    copyFileSync(filePath, join(sourceDir, basename(filePath)));
    clearImportMarker(sourceDir);
    return { ok: true };
  } catch (err) {
    const message = (err as Error).message;
    if (!resuming && countPartialPages(sourceDir) === 0) {
      // Failed before rendering anything (e.g. a corrupt PDF that won't open): there is no
      // partial work worth resuming, so remove the fresh source dir instead of leaving an
      // "interrupted import" for the recovery prompt.
      rmSync(sourceDir, { recursive: true, force: true });
    } else {
      // Keep the marker + png.partial in place so the import can be resumed or discarded;
      // record the failure so the recovery prompt can explain it.
      updateImportMarker(sourceDir, { lastError: message });
    }
    return { ok: false, kind: "error", error: `Import failed for "${sourceName}": ${message}` };
  }
}

// List the importable files directly inside a folder (non-recursive, skips dotfiles).
function collectSupportedFiles(folderPath: string): string[] {
  return readdirSync(folderPath)
    .filter((f) => SUPPORTED_EXTS.has(extname(f).toLowerCase()) && !f.startsWith("."))
    .map((f) => join(folderPath, f))
    .filter((f) => statSync(f).isFile());
}

let runSeq = 0;
function newRunId(): string {
  return `import-${Date.now()}-${++runSeq}`;
}

/**
 * Run importFile over a list of files, reporting through one progress id. A single file
 * reports page progress (done/total pages) once the page count is known; several files
 * report done/total files, with per-file page progress in the message. The last event
 * has done === total and finished: true.
 */
async function runImports(
  title: string,
  items: { file: string; label: string }[],
  sourcesDir: string,
  workers: ImportWorkers,
  progress: ProgressSink,
  onResult: (item: { file: string; label: string }, res: FileResult, result: ImportResult) => void,
  precheck?: (item: { file: string; label: string }, result: ImportResult) => boolean,
): Promise<ImportResult> {
  const id = newRunId();
  const result: ImportResult = { imported: 0, skipped: [], errors: [] };
  const n = items.length;
  const single = n === 1;
  let last = { done: 0, total: n as number | undefined };
  // Once `finished` is sent the run is closed: nothing may reopen the renderer's entry.
  let closed = false;
  const emit = (p: { done: number; total?: number; message?: string; finished?: boolean }) => {
    if (closed) return;
    if (p.finished) closed = true;
    last = { done: p.done, total: p.total };
    try {
      progress({ id, title, ...p });
    } catch {
      // a broken sink must never abort the import
    }
  };

  try {
    for (let i = 0; i < n; i++) {
      const item = items[i];
      const prefix = `(${i + 1}/${n})`;
      if (precheck && !precheck(item, result)) {
        if (!single) emit({ done: i + 1, total: n, message: `${prefix} ${item.label}` });
        continue;
      }
      emit(single ? { done: 0, total: undefined, message: `${prefix} ${item.label}` } : { done: i, total: n, message: `${prefix} ${item.label}` });
      const res = await importFile(item.file, sourcesDir, workers, (msg, pages) => {
        if (single) emit({ done: pages?.done ?? last.done, total: pages?.total ?? last.total, message: `${prefix} ${msg}` });
        else emit({ done: i, total: n, message: `${prefix} ${msg}` });
      });
      if (res.ok) result.imported++;
      onResult(item, res, result);
      if (!single) emit({ done: i + 1, total: n, message: `${prefix} ${item.label}` });
    }
  } finally {
    // Close out the run: done === total (pages for a single page-counted file, else files).
    const total = single && last.total !== undefined && last.done === last.total ? last.total : n;
    emit({ done: total, total, message: summarize(result), finished: true });
  }
  return result;
}

function summarize(r: ImportResult): string {
  return [
    r.imported ? `${r.imported} imported` : "",
    r.skipped.length ? `${r.skipped.length} skipped` : "",
    r.errors.length ? `${r.errors.length} failed` : "",
  ]
    .filter(Boolean)
    .join(", ") || "nothing to do";
}

export async function importFiles(
  files: string[],
  sourcesDir: string,
  workers: ImportWorkers,
  progress: ProgressSink,
): Promise<ImportResult> {
  mkdirSync(sourcesDir, { recursive: true });
  return runImports(
    "Importing sources",
    files.map((file) => ({ file, label: basename(file) })),
    sourcesDir,
    workers,
    progress,
    (item, res, result) => {
      if (res.ok) return;
      // Already-present sources and unsupported types are skipped, not failures.
      if (res.kind === "exists" || res.kind === "unsupported") result.skipped.push(item.label);
      else result.errors.push(res.error);
    },
  );
}

/** Import every supported file directly inside `folder` (non-recursive). */
export async function importFolder(
  folder: string,
  sourcesDir: string,
  workers: ImportWorkers,
  progress: ProgressSink,
): Promise<ImportResult> {
  return importFiles(collectSupportedFiles(folder), sourcesDir, workers, progress);
}

// Re-run interrupted imports from their recorded source files. importFile resumes (skipping
// pages already rendered into png.partial) and finalizes them.
export async function resumeIncompleteImports(
  incompletes: IncompleteImport[],
  sourcesDir: string,
  workers: ImportWorkers,
  progress: ProgressSink,
): Promise<ImportResult> {
  const items = incompletes.map((inc) => ({ file: inc.marker.sourceFile, label: inc.name }));
  return runImports(
    "Resuming interrupted imports",
    items,
    sourcesDir,
    workers,
    progress,
    (item, res, result) => {
      if (!res.ok) result.errors.push(res.error || `Failed: ${item.label}`);
    },
    (item, result) => {
      if (existsSync(item.file)) return true;
      result.errors.push(`${item.label}: original file is gone (${item.file}) — discard it and re-import`);
      return false;
    },
  );
}
