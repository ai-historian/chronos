import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ExpertRegistry } from "./expert-registry.js";
import type { SourceContext } from "./source-context.js";
import { requireSourceDataDir } from "./source-context.js";
import { runExpertTurn } from "./expert-turn.js";

const taskParams = Type.Object({
  prompt: Type.String({ description: "What to ask the expert model." }),
  task_id: Type.Optional(
    Type.String({
      description:
        "Continue an existing expert session. Omit to spawn a new expert; the result ends with " +
        "its `task_id:` — pass that back here for follow-up questions in the same conversation.",
    })
  ),
  page_id: Type.Optional(
    Type.Number({
      description:
        "Attach this page's image to the message (file-system page index, e.g. 1 for page_0001.png — " +
        "NOT the printed page number). Optional: omit for a text-only message.",
    })
  ),
  model: Type.Optional(
    Type.String({
      description:
        `Model as provider/model-id (e.g. "anthropic/claude-opus-4-8"). ` +
        `Default: the orchestrator's current model for new tasks, the session's current model on follow-ups. ` +
        `Any model pi has auth for works; an unknown model errors with the list of available models.`,
    })
  ),
  output_file: Type.Optional(
    Type.String({
      description:
        "If provided, write the model response to this file in the source directory " +
        "(e.g. 'entries_0042.json'). The tool returns a short confirmation instead of the full text.",
    })
  ),
  bbox: Type.Optional(
    Type.Object(
      {
        x: Type.Number({ minimum: 0, maximum: 1 }),
        y: Type.Number({ minimum: 0, maximum: 1 }),
        w: Type.Number({ minimum: 0, maximum: 1 }),
        h: Type.Number({ minimum: 0, maximum: 1 }),
      },
      { description: "Crop region in normalized coordinates (0–1). x/y is the top-left corner, w/h is width/height. Crops the image before sending. Requires page_id." }
    )
  ),
});

export function createTaskTool(
  sourceCtx: SourceContext,
  registry: ExpertRegistry,
  description: string,
  pageExpertPrompt: string,
): ToolDefinition<typeof taskParams> {
  return {
    name: "task",
    label: "Task",
    description,
    parameters: taskParams,
    async execute(_toolCallId, params, signal, _onUpdate, extCtx) {
      const result = await runExpertTurn(registry, sourceCtx, pageExpertPrompt, extCtx, {
        taskId: params.task_id,
        prompt: params.prompt,
        model: params.model,
        pageId: params.page_id,
        bbox: params.bbox,
        signal,
      });

      if (!result.ok) {
        const trailer = result.taskId ? `\ntask_id: ${result.taskId}` : "";
        return {
          content: [{ type: "text", text: `${result.error}${trailer}` }],
          details: result.taskId ? { taskId: result.taskId } : {},
        };
      }

      const { taskId, model, text, cost, pageId, toolUses } = result;
      const bbox = params.bbox ?? null;
      const costStr = cost !== undefined ? ` [cost: $${cost.toFixed(4)}]` : "";

      const viewLink =
        pageId === null
          ? ""
          : bbox
            ? `[view p.${pageId}] [view p.${pageId}#sel=${bbox.x},${bbox.y},${bbox.w},${bbox.h}]\n`
            : `[view p.${pageId}]\n`;
      const trailer = `\ntask_id: ${taskId}`;

      if (params.output_file) {
        const dataDir = requireSourceDataDir(sourceCtx);
        mkdirSync(dataDir, { recursive: true });
        const outPath = join(dataDir, params.output_file);
        writeFileSync(outPath, text || "(empty response)", "utf-8");
        return {
          content: [{ type: "text", text: `${viewLink}→ ${params.output_file}${trailer}` }],
          details: { model, taskId, pageId, bbox, cost: costStr, path: outPath, toolUses },
        };
      }

      return {
        content: [{ type: "text", text: `${viewLink}${text || "(empty response)"}${trailer}` }],
        details: { model, taskId, pageId, bbox, cost: costStr, toolUses },
      };
    },
  };
}
