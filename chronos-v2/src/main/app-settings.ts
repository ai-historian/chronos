import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AppSettings {
  theme: "system" | "light" | "dark";
}

const DEFAULTS: AppSettings = { theme: "system" };

export function readAppSettings(dir: string): AppSettings {
  try {
    const j = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
    const theme = j?.theme === "light" || j?.theme === "dark" || j?.theme === "system" ? j.theme : DEFAULTS.theme;
    return { theme };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeAppSettings(dir: string, s: AppSettings): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.json");
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(s, null, 2), "utf-8");
  renameSync(tmp, file);
}
