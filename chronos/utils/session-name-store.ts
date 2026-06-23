/**
 * Per-session auto-generated display names.
 *
 * Session names in the history list fall back to a truncation of the first user
 * message, which is often a poor label. We generate a short title from the
 * session's user prompts with a cheap model and cache it here, keyed by pi
 * session id, so it isn't recomputed and the host's history scan can read it.
 *
 * Each entry records how many user prompts the name was generated from
 * (`fromPrompts`), so the name can be refined as the session grows (up to a
 * small cap) instead of being frozen on the very first prompt.
 *
 * Like the source sidecar, this is OUT-OF-BAND: it never touches the
 * conversation history or pi's session file. Precedence in the UI is
 * user-set name (pi session_info) > this generated name > first-message
 * truncation.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

interface NameEntry {
  name: string;
  /** How many user prompts the title was summarised from. */
  fromPrompts: number;
}

function storePath(workspaceDir: string): string {
  return join(workspaceDir, ".chronos", "session-names.json");
}

function readStore(workspaceDir: string): Record<string, NameEntry> {
  try {
    const parsed = JSON.parse(readFileSync(storePath(workspaceDir), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** How many user prompts the cached name was generated from (0 if none cached). */
export function getNamedPromptCount(workspaceDir: string, sessionId: string): number {
  if (!sessionId) return 0;
  const entry = readStore(workspaceDir)[sessionId];
  return entry && typeof entry.fromPrompts === "number" ? entry.fromPrompts : 0;
}

/**
 * Cache (or refine) a generated display name. `fromPrompts` records how many
 * prompts it summarises; a later call with more prompts overwrites it. Writes
 * atomically (temp + rename) and re-reads immediately before writing so a
 * concurrent writer's entry for a different session isn't clobbered.
 */
export function saveSessionName(workspaceDir: string, sessionId: string, name: string, fromPrompts: number): void {
  if (!sessionId || !name) return;
  const store = readStore(workspaceDir);
  store[sessionId] = { name, fromPrompts };
  const path = storePath(workspaceDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf-8");
  renameSync(tmp, path); // atomic publish on the same filesystem
}

/** The generated display name for this session, if any. */
export function loadSessionName(workspaceDir: string, sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  return readStore(workspaceDir)[sessionId]?.name;
}
