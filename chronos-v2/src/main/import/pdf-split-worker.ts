import { workerData, parentPort } from "node:worker_threads";
import { openSync, fstatSync, readSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, ParseSpeeds } from "pdf-lib";

// Splits a PDF that is too large for the mupdf WASM renderer (which uses 32-bit file
// offsets and therefore cannot open files >= 2 GiB) into smaller (<2 GiB) part files.
// pdf-lib is pure JS and parses 64-bit xref offsets, so it can read the oversized file
// where mupdf can't; each part is then rendered by the normal mupdf path. No native deps.

interface WorkerData {
  filePath: string;
  outDir: string;
  targetChunkBytes: number; // aim for parts around this size (kept comfortably below 2 GiB)
}

interface ChunkDescriptor {
  path: string;
  pageOffset: number; // 0-indexed global index of this part's first page
  pageCount: number;
}

// Node's readFileSync caps at 2 GiB (ERR_FS_FILE_TOO_LARGE); read in positional chunks
// into one Buffer instead. Buffer.MAX_LENGTH is far larger, and readSync handles offsets
// beyond 2 GiB.
function readWholeFile(filePath: string): Buffer {
  const fd = openSync(filePath, "r");
  try {
    const { size } = fstatSync(fd);
    const buf = Buffer.allocUnsafe(size);
    let pos = 0;
    while (pos < size) {
      const n = readSync(fd, buf, pos, Math.min(1 << 26, size - pos), pos);
      if (n <= 0) break;
      pos += n;
    }
    return buf;
  } finally {
    closeSync(fd);
  }
}

async function main() {
  const { filePath, outDir, targetChunkBytes } = workerData as WorkerData;

  parentPort?.postMessage({ type: "progress", message: "reading file" });
  const bytes = readWholeFile(filePath);

  parentPort?.postMessage({ type: "progress", message: "parsing" });
  const src = await PDFDocument.load(bytes, {
    updateMetadata: false,
    parseSpeed: ParseSpeeds.Fastest,
    throwOnInvalidObject: false,
  });
  const totalPages = src.getPageCount();

  // Estimate pages-per-part from the average page size so each part lands near the target.
  const avgPageBytes = Math.max(1, bytes.length / Math.max(1, totalPages));
  const pagesPerChunk = Math.max(1, Math.floor(targetChunkBytes / avgPageBytes));

  const chunks: ChunkDescriptor[] = [];
  let part = 0;
  for (let start = 0; start < totalPages; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, totalPages);
    const out = await PDFDocument.create();
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    const copied = await out.copyPages(src, indices);
    copied.forEach((p) => out.addPage(p));
    const data = await out.save();
    const path = join(outDir, `part_${String(part).padStart(3, "0")}.pdf`);
    writeFileSync(path, data);
    chunks.push({ path, pageOffset: start, pageCount: end - start });
    part++;
    parentPort?.postMessage({
      type: "progress",
      message: `split ${end}/${totalPages} pages into ${part} part${part > 1 ? "s" : ""}`,
    });
  }

  parentPort?.postMessage({ type: "done", chunks, totalPages });
}

main().catch((err) => {
  parentPort?.postMessage({ type: "error", message: (err as Error).message });
  process.exit(1);
});
