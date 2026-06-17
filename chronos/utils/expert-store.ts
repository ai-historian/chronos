/**
 * Per-session persistence of expert (task / task_batch) conversations.
 *
 * Experts live in an in-memory registry that vanishes when the agent process
 * exits, so `task_id` follow-ups break across restarts. We persist each expert
 * as a compact turn-log keyed by pi session id, and rebuild the registry on
 * session start/switch.
 *
 * Crucially we DON'T store the base64 page images that the in-memory messages
 * carry (a single expert can hold tens of MB of them). Each turn records only
 * the prompt, the page/bbox/source it came from, and the (text-only) assistant
 * response; the image is re-cropped from disk on restore. Like the source
 * sidecar, this is out-of-band — it adds nothing to the model conversation.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { Bbox } from "./crop-image.js";

export interface PersistedTurn {
  prompt: string;
  /** Page whose image was attached (if any) — used to rehydrate from disk. */
  pageId?: number;
  bbox?: Bbox;
  /** Source dir the page came from, captured per-turn (the active source can change). */
  sourceDir?: string;
  /** The model's reply. Text-only for experts, so it serializes small. */
  response: AssistantMessage;
}

export interface PersistedExpert {
  taskId: string;
  modelSpec: string;
  turns: PersistedTurn[];
}

// pi session ids may contain characters that aren't filesystem-safe; keep the
// directory name simple (and recognisable for debugging).
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function sessionDir(workspaceDir: string, sessionId: string): string {
  return join(workspaceDir, ".chronos", "expert-sessions", safeId(sessionId));
}

/**
 * Append one expert turn to its per-task file. Per-task files avoid write
 * contention when task_batch runs experts concurrently (distinct tasks →
 * distinct files; a single task's turns are sequential). Best-effort:
 * persistence failure must never break a live turn.
 */
export function appendExpertTurn(
  workspaceDir: string,
  sessionId: string,
  taskId: string,
  modelSpec: string,
  turn: PersistedTurn,
): void {
  if (!sessionId || !taskId) return;
  try {
    const dir = sessionDir(workspaceDir, sessionId);
    const file = join(dir, `${taskId}.json`);
    let record: PersistedExpert;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      record = parsed && Array.isArray(parsed.turns) ? parsed : { taskId, modelSpec, turns: [] };
    } catch {
      record = { taskId, modelSpec, turns: [] };
    }
    record.modelSpec = modelSpec;
    record.turns.push(turn);
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", "utf-8");
    renameSync(tmp, file); // atomic publish
  } catch (err) {
    console.warn(`[chronos] could not persist expert turn (${taskId}):`, (err as Error).message);
  }
}

/** All persisted expert tasks for a session. Skips corrupt files. */
export function loadExpertTasks(workspaceDir: string, sessionId: string): PersistedExpert[] {
  if (!sessionId) return [];
  let names: string[];
  try {
    names = readdirSync(sessionDir(workspaceDir, sessionId)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: PersistedExpert[] = [];
  for (const name of names) {
    try {
      const rec = JSON.parse(readFileSync(join(sessionDir(workspaceDir, sessionId), name), "utf-8"));
      if (rec && typeof rec.taskId === "string" && typeof rec.modelSpec === "string" && Array.isArray(rec.turns)) {
        out.push(rec);
      }
    } catch {
      // skip corrupt file
    }
  }
  return out;
}
