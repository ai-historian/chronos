import { readFileSync, existsSync } from "node:fs";
import { complete, type ImageContent, type TextContent, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { pageIdToPath } from "../utils/page-files.js";
import type { ExpertRegistry, ExpertSession } from "./expert-registry.js";
import { newTaskId } from "./expert-registry.js";
import type { SourceContext } from "./source-context.js";
import { requireSource } from "./source-context.js";
import { resolveExpertModel } from "../utils/resolve-model.js";
import { cropImageToBase64, type Bbox } from "../utils/crop-image.js";

export const DEFAULT_EXPERT_MODEL = "google/gemini-3-flash-preview";

export function modelSpec(m: { provider: string; id: string }): string {
  return `${m.provider}/${m.id}`;
}

export interface ExpertTurnInput {
  /** Continue an existing session; omit to spawn a new one. */
  taskId?: string;
  prompt: string;
  /** provider/model-id; defaults to the session's model on follow-up, else DEFAULT_EXPERT_MODEL. */
  model?: string;
  /** Attach this page's image to the message. */
  pageId?: number;
  bbox?: Bbox;
}

export type ExpertTurnResult =
  | { ok: true; taskId: string; model: string; text: string; cost: number | undefined; pageId: number | null }
  | { ok: false; error: string; taskId?: string };

/**
 * Run one expert turn: resolve the model, build the (optionally image-bearing)
 * user message, call the model, and persist the exchange in the registry.
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
  if (input.pageId !== undefined) {
    const sourceDir = requireSource(sourceCtx);
    pageId = Math.round(input.pageId);
    const imgPath = pageIdToPath(sourceDir, pageId);
    if (!existsSync(imgPath)) {
      return { ok: false, taskId, error: `Page ${String(pageId).padStart(4, "0")} not found: ${imgPath}` };
    }
    const imageData = input.bbox
      ? await cropImageToBase64(imgPath, input.bbox)
      : readFileSync(imgPath).toString("base64");
    content.push({ type: "image", data: imageData, mimeType: "image/png" });
  }
  content.push({ type: "text", text: input.prompt });

  const fallback = session ? modelSpec(session.model) : DEFAULT_EXPERT_MODEL;
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

  const response = await complete(
    resolved.model,
    { systemPrompt: pageExpertPrompt, messages: [...session.messages, userMessage] },
    { apiKey: resolved.apiKey, headers: resolved.headers },
  );
  if (response.stopReason === "error") {
    return {
      ok: false,
      taskId,
      error: `Expert model error (${modelSpec(resolved.model)}): ${response.errorMessage ?? "unknown error"}`,
    };
  }
  session.messages.push(userMessage, response);

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");

  const cost = response.usage?.cost;
  const costTotal = cost ? cost.input + cost.output + cost.cacheRead : undefined;

  return { ok: true, taskId: taskId!, model: modelSpec(resolved.model), text, cost: costTotal, pageId };
}
