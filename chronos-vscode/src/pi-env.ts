import * as vscode from "vscode";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Single source of truth for locating the `pi` binary. Detection (hasPi) and the
// agent launcher (PiRpcSession) MUST resolve it the same way — otherwise a working
// install that isn't on GUI-launched VS Code's minimal PATH reads as "missing",
// triggering redundant install prompts and a perpetually-unchecked setup step.
export function resolvePiBin(): string {
  const configured = vscode.workspace.getConfiguration("chronos").get<string>("piPath");
  if (configured?.trim()) return configured.trim();
  // GUI-launched VS Code doesn't source shell rc files, so PATH may miss the
  // npm global bin dir. Probe PATH first, then common install locations.
  try {
    execSync(process.platform === "win32" ? "where pi" : "command -v pi", { stdio: "ignore" });
    return "pi";
  } catch {
    const home = homedir();
    const candidates = [
      join(home, ".npm-global", "bin", "pi"),
      join(home, ".local", "bin", "pi"),
      join(home, ".npm", "bin", "pi"),
      "/usr/local/bin/pi",
      "/opt/homebrew/bin/pi",
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return "pi"; // let the caller fail with a clear ENOENT
  }
}

// True when pi is actually runnable, resolved exactly the way the agent launches
// it — so "is pi present?" can never disagree with "how do we run pi?".
export function hasPi(): boolean {
  try {
    execSync(`"${resolvePiBin()}" --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
