import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── workspace settings (.chronos/settings.json — shared with the pi-package,
//    which reads the `yolo` flag on every bash call) ────────────────────────

export interface ChronosSettings {
  yolo?: boolean;
  allowedCommands?: string[];
  [key: string]: unknown;
}

export function readChronosSettings(workspaceDir: string): ChronosSettings {
  try {
    return JSON.parse(readFileSync(join(workspaceDir, ".chronos", "settings.json"), "utf-8"));
  } catch {
    return {};
  }
}

export function writeChronosSettings(workspaceDir: string, settings: ChronosSettings): void {
  const dir = join(workspaceDir, ".chronos");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

// Multi-word launchers where the subcommand is the meaningful unit: suggest
// "git status" rather than all of "git".
const PREFIX_LAUNCHERS = new Set([
  "git", "npm", "pnpm", "yarn", "pip", "pip3", "python", "python3",
  "node", "cargo", "docker", "uv", "poetry", "make",
]);

export function suggestPrefix(command: string): string {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length >= 2 && PREFIX_LAUNCHERS.has(tokens[0])) {
    return `${tokens[0]} ${tokens[1]}`;
  }
  return tokens[0] ?? command.trim();
}

export function commandMatchesPrefix(command: string, prefix: string): boolean {
  const cmd = command.trim();
  return cmd === prefix || cmd.startsWith(prefix + " ");
}
