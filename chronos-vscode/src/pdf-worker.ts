import { workerData, parentPort } from "node:worker_threads";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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

  // Open by filename — mupdf uses memory-mapped I/O, much less RAM than loading a buffer
  const doc = mupdf.Document.openDocument(filePath, "application/pdf");

  for (let i = startPage; i < endPage; i++) {
    const page = doc.loadPage(i);
    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(scale, scale),
      mupdf.ColorSpace.DeviceRGB,
      false,
    );
    const pageNum = String(pageOffset + i + 1).padStart(4, "0");
    writeFileSync(join(pngDir, `page_${pageNum}.png`), pixmap.asPNG());
    parentPort?.postMessage({ type: "progress", page: pageOffset + i + 1 });
  }

  parentPort?.postMessage({ type: "done", rendered: endPage - startPage });
}

main().catch((err) => {
  parentPort?.postMessage({ type: "error", message: err.message });
  process.exit(1);
});
