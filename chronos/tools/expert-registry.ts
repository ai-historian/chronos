import type { Api, Message, Model } from "@mariozechner/pi-ai";

/**
 * Registry of expert sessions keyed by task ID.
 * The `task` tool spawns a session per task (omitting task_id) and continues
 * one by passing its task_id back, so multiple experts can be alive at once.
 * Sessions are in-memory only — they vanish when the agent process exits.
 */
export interface ExpertSession {
  /** Full message history including assistant replies. */
  messages: Message[];
  /** Resolved model used for this session (updated when a follow-up overrides it). */
  model: Model<Api>;
}

export interface ExpertRegistry {
  sessions: Map<string, ExpertSession>;
  nextId: number;
}

export function createExpertRegistry(): ExpertRegistry {
  return { sessions: new Map(), nextId: 1 };
}

export function newTaskId(registry: ExpertRegistry): string {
  return `task-${registry.nextId++}`;
}
