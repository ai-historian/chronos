import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Validate that a source directory exists and has a png/ subdirectory. */
export function validateSourceDir(sourcePath: string): string {
  const dir = resolve(sourcePath);

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Not a directory: ${dir}`);
  }

  const pngDir = join(dir, "png");
  if (!existsSync(pngDir) || !statSync(pngDir).isDirectory()) {
    throw new Error(`No png/ subdirectory in: ${dir}`);
  }

  return dir;
}
