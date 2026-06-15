import { workerData, parentPort } from "node:worker_threads";
import { writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { withPdfDocument } from "./pdf-stream";

interface WorkerData {
  filePath: string;
  pngDir: string;
  startPage: number;  // 0-indexed
  endPage: number;    // exclusive
  pageOffset: number; // added to page index for PNG naming (0 when using original PDF)
  dpi: number;
}

async function main() {
  const mupdf = await import("mupdf");
  const { filePath, pngDir, startPage, endPage, pageOffset, dpi } = workerData as WorkerData;
  const scale = dpi / 72;

  // Stream the PDF (see withPdfDocument): mupdf reads only this batch's pages on demand
  // instead of buffering the whole file, so memory stays flat no matter the file size.
  withPdfDocument(mupdf, filePath, (doc) => {
    for (let i = startPage; i < endPage; i++) {
      const globalPage = pageOffset + i + 1;
      const target = join(pngDir, `page_${String(globalPage).padStart(4, "0")}.png`);
      // Resume support: a present PNG is fully written (we rename atomically below), so skip it.
      if (existsSync(target)) {
        parentPort?.postMessage({ type: "progress", page: globalPage });
        continue;
      }
      const page = doc.loadPage(i);
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
      );
      // Write to a temp file then rename: a crash mid-write can't leave a truncated PNG that
      // a later resume would wrongly treat as done.
      const tmp = target + ".tmp";
      writeFileSync(tmp, pixmap.asPNG());
      renameSync(tmp, target);
      // Free the page's WASM memory before the next one so a large batch can't pile up.
      pixmap.destroy();
      page.destroy();
      parentPort?.postMessage({ type: "progress", page: globalPage });
    }
  });

  parentPort?.postMessage({ type: "done", rendered: endPage - startPage });
}

main().catch((err) => {
  parentPort?.postMessage({ type: "error", message: err.message });
  process.exit(1);
});
