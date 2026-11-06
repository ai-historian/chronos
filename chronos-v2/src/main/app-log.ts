import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

// The app log behind Help ▸ Show logs: <logs>/chronos.log, the previous run's log rotated to
// chronos.log.1 on start. Electron-free so it is testable under plain Node. Never log env
// values (PiLaunch.env carries API keys and tokens) — callers log only the bin and args.

let logFile: string | undefined;
let consolePatched = false;

/** Start a fresh chronos.log in `logsDir` (keeping one previous) and tee console.log/warn/error into it. */
export function installAppLog(logsDir: string): string {
  mkdirSync(logsDir, { recursive: true });
  const file = join(logsDir, "chronos.log");
  if (existsSync(file)) {
    rmSync(file + ".1", { force: true });
    renameSync(file, file + ".1");
  }
  writeFileSync(file, "", "utf-8");
  logFile = file;
  if (!consolePatched) {
    consolePatched = true;
    for (const level of ["log", "warn", "error"] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        original(...args);
        appendAppLog(`[${level}] ${format(...args)}`);
      };
    }
  }
  return file;
}

/** Append one timestamped line to the app log (no-op until installAppLog ran). */
export function appendAppLog(line: string): void {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, "utf-8");
  } catch {
    // Logging must never take the app down (disk full, folder removed, …).
  }
}

/** Path of the current log file, if installed. */
export function appLogPath(): string | undefined {
  return logFile;
}
