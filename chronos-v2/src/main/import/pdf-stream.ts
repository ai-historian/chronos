import { openSync, fstatSync, readSync, closeSync } from "node:fs";

// mupdf is ESM-only and this file compiles as CommonJS (module: Node16), so its types
// can't be imported statically here. We describe the minimal surface we touch and infer
// the concrete Document type from the module value the caller passes (their `await import`),
// so callers still get a fully-typed `doc` inside `fn`.
interface StreamHandle {
  fileSize(): number;
  read(memory: Uint8Array, offset: number, length: number, position: number): number;
  close(): void;
}
interface MupdfLike {
  Stream: new (handle: StreamHandle) => { destroy(): void };
  Document: { openDocument(from: unknown, magic?: string): { destroy(): void } };
}

// Open a PDF with mupdf through a seekable stream backed by a Node file descriptor, run
// `fn` against the document, then release the document, the stream and the fd.
//
// Why not the simpler `mupdf.Document.openDocument(filePath)`? That path calls
// `fs.readFileSync` internally, which (a) caps at 2 GiB and throws ERR_FS_FILE_TOO_LARGE
// on larger files and (b) loads the entire file into WASM memory even when it fits.
// A StreamHandle instead lets mupdf call back for just the bytes it needs at a given
// offset (the xref table, then each page's objects on demand), so memory stays flat and
// there is no file-size limit — which is what previously forced the native `mutool`
// fallback. mupdf keeps its own reference to the stream after openDocument (it drops its
// implicit buffer the same way), so we release ours immediately; the fd is closed when the
// document is dropped, via the StreamHandle.close callback.
export function withPdfDocument<M extends MupdfLike, T>(
  mupdf: M,
  filePath: string,
  fn: (doc: ReturnType<M["Document"]["openDocument"]>) => T,
): T {
  const fd = openSync(filePath, "r");
  const { size } = fstatSync(fd);
  let closed = false;
  const closeFd = () => {
    if (!closed) {
      closed = true;
      closeSync(fd);
    }
  };

  const stream = new mupdf.Stream({
    fileSize: () => size,
    // `memory` is a view into mupdf's WASM heap; read the requested slice straight into
    // it. readSync takes an explicit position, so the file is never buffered whole and
    // offsets beyond 2 GiB are fine. A short read (or 0 at EOF) is returned as-is.
    read: (memory, offset, length, position) => readSync(fd, memory, offset, length, position),
    close: closeFd,
  });

  let doc: ReturnType<M["Document"]["openDocument"]>;
  try {
    doc = mupdf.Document.openDocument(stream, "application/pdf") as ReturnType<M["Document"]["openDocument"]>;
  } catch (err) {
    stream.destroy(); // last reference -> close callback -> closeFd()
    throw err;
  }
  stream.destroy(); // the document holds its own reference now

  try {
    return fn(doc);
  } finally {
    doc.destroy(); // last reference -> close callback closes the fd
    closeFd(); // in case the drop did not reach the callback
  }
}
