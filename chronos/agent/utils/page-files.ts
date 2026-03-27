import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const IMAGE_EXTS = [".png", ".jpg", ".jpeg"];

/**
 * List all page IDs from image files in the source's png/ directory.
 * Files are expected to be named page_NNNN.{png,jpg,jpeg} (4-digit zero-padded).
 */
export function listPageIds(sourceDir: string): number[] {
  const pngDir = join(sourceDir, "png");
  const pages: number[] = [];
  const seen = new Set<number>();

  let entries: string[];
  try {
    entries = readdirSync(pngDir);
  } catch {
    return [];
  }

  for (const name of entries) {
    const lower = name.toLowerCase();
    if (!name.startsWith("page_")) continue;
    if (!IMAGE_EXTS.some((ext) => lower.endsWith(ext))) continue;
    const num = parseInt(name.split("_")[1], 10);
    if (!isNaN(num) && !seen.has(num)) {
      seen.add(num);
      pages.push(num);
    }
  }

  return pages.sort((a, b) => a - b);
}

/** Resolve a page ID to its image file path (checks .png, .jpg, .jpeg). */
export function pageIdToPath(sourceDir: string, pageId: number): string {
  const base = join(sourceDir, "png", `page_${String(pageId).padStart(4, "0")}`);
  for (const ext of IMAGE_EXTS) {
    const p = base + ext;
    if (existsSync(p)) return p;
  }
  return base + ".png"; // fallback (may not exist)
}
