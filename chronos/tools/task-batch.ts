import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ExpertRegistry } from "./expert-registry.js";
import type { SourceContext } from "./source-context.js";
import { requireSourceDataDir } from "./source-context.js";
import type { ToolText } from "../utils/tool-loader.js";
import { runExpertTurn, type ExpertTurnInput } from "./expert-turn.js";
import { type Bbox } from "../utils/crop-image.js";

interface ExpertEntry {
  taskId?: string;
  page_id: number;
  status: "ok" | "error";
  response?: string;
  file?: string;
  error?: string;
  cost?: number;
}

const taskBatchParams = Type.Object({
  page_ids: Type.Array(Type.Number(), {
    description:
      "Array of page IDs to spawn an expert for (e.g. [42, 43, 44]). " +
      "These are file-system indices, not printed page numbers.",
  }),
  prompt: Type.String({ description: "The prompt sent to each page's expert." }),
  model: Type.Optional(
    Type.String({
      description:
        `Model as provider/model-id (e.g. "anthropic/claude-opus-4-8"). ` +
        `Default: the orchestrator's current model. Any model pi has auth for works; ` +
        `an unknown model errors with the list of available models.`,
    }),
  ),
  output_file: Type.Optional(
    Type.String({
      description:
        "File name template with a {page_id} placeholder (e.g. 'entries_{page_id}.json'). " +
        "Each page's response is written to a separate file in the source directory. " +
        "{page_id} is replaced with the zero-padded page number (e.g. 0042). " +
        "If omitted, results are returned inline.",
    }),
  ),
  concurrency: Type.Optional(
    Type.Number({
      description: "Max parallel API calls. Default: 4. Higher values are faster but cost more concurrent quota.",
      minimum: 1,
      maximum: 20,
    }),
  ),
  bbox: Type.Optional(
    Type.Object(
      {
        x: Type.Number({ minimum: 0, maximum: 1 }),
        y: Type.Number({ minimum: 0, maximum: 1 }),
        w: Type.Number({ minimum: 0, maximum: 1 }),
        h: Type.Number({ minimum: 0, maximum: 1 }),
      },
      { description: "Crop region in normalized coordinates (0–1). Applied to every page before sending to the model." }
    )
  ),
});

export function createTaskBatchTool(
  sourceCtx: SourceContext,
  registry: ExpertRegistry,
  toolText: ToolText,
  pageExpertPrompt: string,
): ToolDefinition<typeof taskBatchParams> {
  return {
    name: "task_batch",
    label: "Task (Batch)",
    description: toolText.description,
    promptGuidelines: toolText.promptGuidelines,
    parameters: taskBatchParams,
    async execute(_toolCallId, params, signal, _onUpdate, extCtx) {
      const outputDir = requireSourceDataDir(sourceCtx);
      mkdirSync(outputDir, { recursive: true });
      const pageIds = params.page_ids.map((id) => Math.round(id));
      const outputFileTemplate = params.output_file;
      const bbox = params.bbox as Bbox | undefined;

      if (outputFileTemplate && !outputFileTemplate.includes("{page_id}")) {
        return {
          content: [{ type: "text", text: "output_file must contain {page_id} placeholder (e.g. 'entries_{page_id}.json')." }],
          details: {},
        };
      }
      if (pageIds.length === 0) {
        return { content: [{ type: "text", text: "No page IDs provided." }], details: {} };
      }

      const experts: ExpertEntry[] = [];
      let resolvedModel = params.model ?? "(orchestrator default)";

      const runOne = async (pageId: number): Promise<ExpertEntry> => {
        const input: ExpertTurnInput = { prompt: params.prompt, model: params.model, pageId, bbox, signal };
        const result = await runExpertTurn(registry, sourceCtx, pageExpertPrompt, extCtx, input);
        if (!result.ok) {
          return { page_id: pageId, status: "error", error: result.error };
        }
        resolvedModel = result.model;
        if (outputFileTemplate) {
          const filename = outputFileTemplate.replace("{page_id}", String(pageId).padStart(4, "0"));
          writeFileSync(join(outputDir, filename), result.text || "(empty response)", "utf-8");
          return { taskId: result.taskId, page_id: pageId, status: "ok", file: filename, cost: result.cost };
        }
        return { taskId: result.taskId, page_id: pageId, status: "ok", response: result.text || "(empty response)", cost: result.cost };
      };

      // Concurrency-limited worker pool.
      const concurrency = params.concurrency ?? 4;
      const queue = [...pageIds];
      const workers: Promise<void>[] = [];
      for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
        workers.push(
          (async () => {
            while (queue.length > 0) {
              if (signal?.aborted) return;
              const pageId = queue.shift()!;
              experts.push(await runOne(pageId));
            }
          })(),
        );
      }
      await Promise.all(workers);
      experts.sort((a, b) => a.page_id - b.page_id);

      const okCount = experts.filter((e) => e.status === "ok").length;
      const errCount = experts.filter((e) => e.status === "error").length;
      const totalCost = experts.reduce((sum, e) => sum + (e.cost ?? 0), 0);

      const lines = [
        `Batch complete: ${okCount}/${pageIds.length} succeeded` +
          (errCount > 0 ? `, ${errCount} failed` : "") +
          (totalCost > 0 ? ` [total cost: $${totalCost.toFixed(4)}]` : ""),
        "",
        ...experts.map((e) =>
          e.status === "ok"
            ? `${e.taskId} ⇒ p.${e.page_id}${e.file ? ` → ${e.file}` : ""}`
            : `(failed) p.${e.page_id}: ${e.error}`,
        ),
        "",
        "Follow up on any page with task(task_id, prompt).",
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { model: resolvedModel, prompt: params.prompt, bbox: bbox ?? null, experts },
      };
    },
  };
}
