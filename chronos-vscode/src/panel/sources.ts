import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

export interface SourceInfo {
  name: string;
  path: string;
}

export function countPages(sourceDir: string): number {
  const pngDir = join(sourceDir, "png");
  try {
    return readdirSync(pngDir).filter(
      (f) => f.startsWith("page_") && /\.(png|jpg|jpeg)$/i.test(f)
    ).length;
  } catch {
    return 0;
  }
}

export function discoverSources(rootDir: string): SourceInfo[] {
  const sources: SourceInfo[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    if (existsSync(join(dir, "png")) && statSync(join(dir, "png")).isDirectory()) {
      sources.push({ name: relative(rootDir, dir), path: dir });
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory() && !entry.startsWith(".")) {
          walk(full);
        }
      } catch {
        // skip unreadable
      }
    }
  }

  walk(rootDir);
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}
