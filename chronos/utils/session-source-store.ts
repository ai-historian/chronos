/**
 * Per-session source selection persistence.
 *
 * The active source lives in an in-memory SourceContext that drives the tools
 * and the per-turn system prompt. A fresh agent process (or a resumed session)
 * starts with no source, so the agent "forgets" what it was working on. We
 * persist the choice in a sidecar keyed by pi session id and restore it on
 * session start/switch.
 *
 * This is deliberately OUT-OF-BAND: it adds nothing to the conversation
 * history, so the message array sent to the model API is unaffected. Restoring
 * only re-sets the in-memory context; the system prompt (rebuilt every turn)
 * then reflects the source with zero extra messages.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

function storePath(workspaceDir: string): string {
  return join(workspaceDir, ".chronos", "session-sources.json");
}

function readStore(workspaceDir: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(storePath(workspaceDir), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Record the source directory selected in this session. No-op if unchanged. */
export function saveSessionSource(workspaceDir: string, sessionId: string, sourceDir: string): void {
  if (!sessionId || !sourceDir) return;
  const store = readStore(workspaceDir);
  if (store[sessionId] === sourceDir) return;
  store[sessionId] = sourceDir;
  const path = storePath(workspaceDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

/** The source directory last selected in this session, if any still recorded. */
export function loadSessionSource(workspaceDir: string, sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  return readStore(workspaceDir)[sessionId];
}
