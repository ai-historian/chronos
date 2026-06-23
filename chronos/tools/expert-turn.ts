import { readFileSync, existsSync } from "node:fs";
import {
  complete,
  type ImageContent,
  type Message,
  type TextContent,
  type ToolCall,
  type UserMessage,
} from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { pageIdToPath } from "../utils/page-files.js";
import type { ExpertRegistry, ExpertSession } from "./expert-registry.js";
import { newTaskId } from "./expert-registry.js";
import type { SourceContext } from "./source-context.js";
import { requireSource } from "./source-context.js";
import { resolveExpertModel } from "../utils/resolve-model.js";
import { cropImageToBase64, type Bbox } from "../utils/crop-image.js";
import { appendExpertTurn, type PersistedExpert, type PersistedStep } from "../utils/expert-store.js";
import { EXPERT_TOOLS, executeExpertTool, rehydrateToolResult } from "./expert-tools.js";

// Bound the per-turn agentic loop so a confused expert can't spin on tool calls.
const MAX_EXPERT_TOOL_CALLS = 8;

export function modelSpec(m: { provider: string; id: string }): string {
  return `${m.provider}/${m.id}`;
}

/**
 * Build the image content block for an expert turn by reading (and optionally
 * cropping) the page from disk. Shared by live turns and session restore, so a
 * persisted expert rehydrates its images without storing base64 on disk.
 */
export async function pageImageContent(sourceDir: string, pageId: number, bbox?: Bbox): Promise<ImageContent> {
  const imgPath = pageIdToPath(sourceDir, pageId);
  if (!existsSync(imgPath)) {
    throw new Error(`Page ${String(pageId).padStart(4, "0")} not found: ${imgPath}`);
  }
  const data = bbox ? await cropImageToBase64(imgPath, bbox) : readFileSync(imgPath).toString("base64");
  return { type: "image", data, mimeType: "image/png" };
}

export interface ExpertTurnInput {
  /** Continue an existing session; omit to spawn a new one. */
  taskId?: string;
  prompt: string;
  /** provider/model-id; defaults to the session's model on follow-up, else the orchestrator's current model. */
  model?: string;
  /** Attach this page's image to the message. */
  pageId?: number;
  bbox?: Bbox;
  /** Abort the (multi-call) agentic loop when the user cancels. */
  signal?: AbortSignal;
}

export type ExpertTurnResult =
  | { ok: true; taskId: string; model: string; text: string; cost: number | undefined; pageId: number | null }
  | { ok: false; error: string; taskId?: string };

function isToolCall(c: { type: string }): c is ToolCall {
  return c.type === "toolCall";
}

/**
 * Run one expert turn: resolve the model, build the (optionally image-bearing)
 * user message, then run an agentic loop — the model may call `view_region` /
 * `view_page` to pull in more imagery before answering. The full exchange
 * (intermediate tool calls + results) is kept in the session and persisted.
 * Shared by the `task` tool (single, formatted) and `task_batch` (many).
 */
export async function runExpertTurn(
  registry: ExpertRegistry,
  sourceCtx: SourceContext,
  pageExpertPrompt: string,
  extCtx: ExtensionContext,
  input: ExpertTurnInput,
): Promise<ExpertTurnResult> {
  if (input.bbox && input.pageId === undefined) {
    return { ok: false, error: "bbox requires page_id." };
  }

  // Resolve the session first so a follow-up can default to its model.
  let session: ExpertSession | undefined;
  let taskId = input.taskId;
  if (taskId) {
    session = registry.sessions.get(taskId);
    if (!session) {
      const active = [...registry.sessions.keys()];
      return {
        ok: false,
        error: `Unknown task_id "${taskId}". Active tasks: ${active.length > 0 ? active.join(", ") : "(none)"}.`,
      };
    }
  }

  // Build the user message; attach a page image only when page_id is given.
  const content: (TextContent | ImageContent)[] = [];
  let pageId: number | null = null;
  let turnSourceDir: string | undefined;
  if (input.pageId !== undefined) {
    const sourceDir = requireSource(sourceCtx);
    pageId = Math.round(input.pageId);
    try {
      content.push(await pageImageContent(sourceDir, pageId, input.bbox));
    } catch (e) {
      return { ok: false, taskId, error: (e as Error).message };
    }
    turnSourceDir = sourceDir;
  } else if (sourceCtx.sourceDir) {
    // No image attached, but a source is active — let the expert's tools reach it.
    turnSourceDir = sourceCtx.sourceDir;
  }
  content.push({ type: "text", text: input.prompt });

  // Default to the session's model on follow-up, else the orchestrator's current
  // model (whatever the user has selected/authed in pi) — no provider is baked in.
  const fallback = session
    ? modelSpec(session.model)
    : extCtx.model
      ? modelSpec(extCtx.model)
      : undefined;
  const resolved = await resolveExpertModel(input.model, extCtx.modelRegistry, fallback, pageId !== null);
  if (!resolved.ok) {
    return { ok: false, taskId, error: resolved.error };
  }

  if (!session) {
    taskId = newTaskId(registry);
    session = { messages: [], model: resolved.model };
    registry.sessions.set(taskId, session);
  } else {
    session.model = resolved.model;
  }

  const userMessage: UserMessage = { role: "user", content, timestamp: Date.now() };

  // ── Agentic loop ─────────────────────────────────────────────────────────
  // turnMessages accumulates everything this turn appends after the prior
  // session history: the user message, intermediate tool calls/results, and the
  // final answer. steps captures the intermediate exchange for persistence.
  const turnMessages: Message[] = [userMessage];
  const steps: PersistedStep[] = [];
  let currentPageId: number | null = pageId;
  let toolCallCount = 0;
  // Only offer the image-returning view tools to a model that can actually
  // consume images; a text-only model just answers in text.
  let toolsEnabled = resolved.model.input.includes("image");
  let totalCost = 0;
  let finalResponse;

  for (;;) {
    if (input.signal?.aborted) {
      return { ok: false, taskId, error: "Expert turn aborted." };
    }
    const response = await complete(
      resolved.model,
      {
        systemPrompt: pageExpertPrompt,
        messages: [...session.messages, ...turnMessages],
        tools: toolsEnabled ? EXPERT_TOOLS : undefined,
      },
      { apiKey: resolved.apiKey, headers: resolved.headers, signal: input.signal },
    );
    if (response.stopReason === "error") {
      return {
        ok: false,
        taskId,
        error: `Expert model error (${modelSpec(resolved.model)}): ${response.errorMessage ?? "unknown error"}`,
      };
    }
    turnMessages.push(response);
    finalResponse = response;
    totalCost += response.usage?.cost?.total ?? 0;

    const toolCalls = toolsEnabled ? response.content.filter(isToolCall) : [];
    if (response.stopReason !== "toolUse" || toolCalls.length === 0) break;

    // Intermediate assistant turn — record it, then run each requested tool.
    steps.push({ kind: "assistant", message: response });
    for (const call of toolCalls) {
      toolCallCount++;
      const outcome = await executeExpertTool(call, { sourceDir: turnSourceDir, currentPageId });
      turnMessages.push(outcome.message);
      steps.push({ kind: "toolResult", toolResult: outcome.persist });
      if (outcome.viewedPageId !== undefined) currentPageId = outcome.viewedPageId;
    }
    // Spent the budget — drop tools so the next completion must answer in text.
    if (toolCallCount >= MAX_EXPERT_TOOL_CALLS) toolsEnabled = false;
  }

  session.messages.push(...turnMessages);

  const text = finalResponse.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");

  // Persist this turn so the expert survives an agent restart. Compact: prompt +
  // provenance + the (text-only) agentic exchange; page images are re-cropped
  // from disk on restore. Best-effort — appendExpertTurn never throws.
  appendExpertTurn(extCtx.cwd, extCtx.sessionManager.getSessionId(), taskId!, modelSpec(resolved.model), {
    prompt: input.prompt,
    pageId: pageId ?? undefined,
    bbox: input.bbox,
    sourceDir: turnSourceDir,
    steps: steps.length > 0 ? steps : undefined,
    response: finalResponse,
  });

  return {
    ok: true,
    taskId: taskId!,
    model: modelSpec(resolved.model),
    text,
    cost: totalCost > 0 ? totalCost : undefined,
    pageId,
  };
}

/**
 * Rebuild in-memory expert sessions from their persisted turn-logs, re-cropping
 * page images (and any tool-driven zoom crops) from disk. Skips a task whose
 * model can no longer be resolved (e.g. missing API key); restores a turn
 * text-only if its source page is gone. Mutates the registry in place.
 */
export async function restoreExpertSessions(
  registry: ExpertRegistry,
  extCtx: ExtensionContext,
  persisted: PersistedExpert[],
): Promise<void> {
  let maxId = 0;
  for (const rec of persisted) {
    const messages: Message[] = [];
    for (const turn of rec.turns) {
      const content: (TextContent | ImageContent)[] = [];
      if (turn.pageId !== undefined && turn.sourceDir) {
        try {
          content.push(await pageImageContent(turn.sourceDir, turn.pageId, turn.bbox));
        } catch {
          // page/source no longer on disk — restore this turn text-only
        }
      }
      content.push({ type: "text", text: turn.prompt });
      const userMessage: UserMessage = { role: "user", content, timestamp: turn.response.timestamp };
      messages.push(userMessage);
      // Replay the agentic exchange (assistant tool calls + re-hydrated results).
      for (const step of turn.steps ?? []) {
        if (step.kind === "assistant") {
          messages.push(step.message);
        } else {
          messages.push(await rehydrateToolResult(step.toolResult));
        }
      }
      messages.push(turn.response);
    }
    const resolved = await resolveExpertModel(rec.modelSpec, extCtx.modelRegistry, undefined, false);
    if (!resolved.ok) continue;
    registry.sessions.set(rec.taskId, { messages, model: resolved.model });
    const n = parseInt(rec.taskId.replace(/^task-/, ""), 10);
    if (!isNaN(n) && n > maxId) maxId = n;
  }
  if (maxId + 1 > registry.nextId) registry.nextId = maxId + 1;
}
