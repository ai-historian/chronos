import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Workspace `.chronos/.env` helpers (moved from the VS Code extension).

export function readEnvFile(envPath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!existsSync(envPath)) return vars;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    // Accept mixed-case names so any var the login flow can write (the "Other
    // provider…" path allows [A-Za-z_]…) round-trips on the next session.
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) vars[match[1]] = match[2].trim();
  }
  return vars;
}

// Set KEY=value in a .env file, replacing any existing assignment of KEY.
export function upsertEnvVar(envPath: string, key: string, value: string): void {
  mkdirSync(dirname(envPath), { recursive: true });
  const kept = existsSync(envPath)
    ? readFileSync(envPath, "utf-8")
        .split("\n")
        .filter((line) => {
          const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
          return !(m && m[1] === key);
        })
    : [];
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  kept.push(`${key}=${value}`);
  // The .env holds billing-bearing provider API keys — keep it owner-only.
  // writeFileSync's mode only applies on creation, so chmod too to tighten a
  // pre-existing (possibly group/world-readable) file.
  writeFileSync(envPath, kept.join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(envPath, 0o600);
  } catch {
    /* best-effort (e.g. unsupported fs) */
  }
}
