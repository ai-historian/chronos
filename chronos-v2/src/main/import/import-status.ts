import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Imports can take minutes (large PDFs render hundreds of pages). To survive a crash we
// track progress on disk:
//   - pages are rendered into `<source>/png.partial/` and the dir is atomically renamed to
//     `<source>/png/` only once the import finishes, so an interrupted source never looks
//     like a complete one (a complete source is exactly one that has `png/`);
//   - a `<source>/.importing.json` marker exists for the duration of an import and is removed
//     on success — so a leftover marker means that import was interrupted and can be resumed.
const MARKER = ".importing.json";
// Dot-prefixed so source discovery (which skips dot-dirs) never treats an in-progress
// import as a source; it's atomically renamed to `png/` only when the import completes.
const PARTIAL = ".png.partial";

export interface ImportMarker {
  source: string;
  sourceFile: string; // absolute path to the original file (needed to resume)
  dpi: number;
  startedAt: string; // ISO timestamp
  expectedPages?: number; // known once the PDF is counted/split
  lastError?: string; // set if the import threw (vs. a hard process crash, which leaves none)
}

export function partialPngDir(sourceDir: string): string {
  return join(sourceDir, PARTIAL);
}

export function readImportMarker(sourceDir: string): ImportMarker | null {
  try {
    return JSON.parse(readFileSync(join(sourceDir, MARKER), "utf-8")) as ImportMarker;
  } catch {
    return null;
  }
}

// Atomic write (temp + rename) so a crash can't leave a half-written marker.
export function writeImportMarker(sourceDir: string, marker: ImportMarker): void {
  const tmp = join(sourceDir, MARKER + ".tmp");
  writeFileSync(tmp, JSON.stringify(marker, null, 2));
  renameSync(tmp, join(sourceDir, MARKER));
}

export function updateImportMarker(sourceDir: string, patch: Partial<ImportMarker>): void {
  const cur = readImportMarker(sourceDir);
  if (cur) writeImportMarker(sourceDir, { ...cur, ...patch });
}

export function clearImportMarker(sourceDir: string): void {
  rmSync(join(sourceDir, MARKER), { force: true });
}

export function countPartialPages(sourceDir: string): number {
  try {
    return readdirSync(partialPngDir(sourceDir)).filter(
      (f) => f.startsWith("page_") && /\.(png|jpg|jpeg)$/i.test(f),
    ).length;
  } catch {
    return 0;
  }
}

// Promote a finished import: drop any stray temp files, then atomically swap png.partial -> png.
export function finalizePartialImport(sourceDir: string): void {
  const partial = partialPngDir(sourceDir);
  for (const f of readdirSync(partial)) {
    if (f.endsWith(".tmp")) rmSync(join(partial, f), { force: true });
  }
  renameSync(partial, join(sourceDir, "png"));
  clearImportMarker(sourceDir);
}

export interface IncompleteImport {
  name: string;
  sourceDir: string;
  marker: ImportMarker;
  renderedPages: number;
}

// Scan a sources/ directory for interrupted imports (those still carrying a marker).
export function findIncompleteImports(sourcesDir: string): IncompleteImport[] {
  let entries: string[];
  try {
    entries = readdirSync(sourcesDir);
  } catch {
    return [];
  }
  const out: IncompleteImport[] = [];
  for (const name of entries) {
    const sourceDir = join(sourcesDir, name);
    const marker = readImportMarker(sourceDir);
    if (marker) out.push({ name, sourceDir, marker, renderedPages: countPartialPages(sourceDir) });
  }
  return out;
}
