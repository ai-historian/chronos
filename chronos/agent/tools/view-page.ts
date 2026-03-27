import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { complete, getModel, StringEnum } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { pageIdToPath } from "../utils/page-files.js";
import type { PageExpertState } from "./page-expert-state.js";
import type { SourceContext } from "./source-context.js";
import { requireSource, requireSourceDataDir } from "./source-context.js";
import { cropImageToBase64 } from "../utils/crop-image.js";

const DEFAULT_MODEL_ID = "gemini-3-flash-preview";

const analyzePageParams = Type.Object({
  page_id: Type.Number({ description: "The file-system page index (e.g. 1 for page_0001.png). This is NOT the printed page number inside the document — those may differ." }),
  prompt: Type.String({ description: "What to ask the vision model about this page." }),
  model: Type.Optional(
    StringEnum(
      ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro", "gemini-3-flash-preview", "gemini-3.1-pro-preview"] as const,
      { description: `Gemini model to use. Default: ${DEFAULT_MODEL_ID}` }
    )
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
      { description: "Crop region in normalized coordinates (0–1). x/y is the top-left corner, w/h is width/height. Crops the image before sending to the vision model." }
    )
  ),
});

export function createAnalyzePageTool(
  ctx: SourceContext,
  state: PageExpertState,
  description: string,
  pageExpertPrompt: string,
): ToolDefinition<typeof analyzePageParams> {
  return {
    name: "ask_page",
    label: "Ask Page",
    description,
    parameters: analyzePageParams,
    async execute(_toolCallId, params) {
      const sourceDir = requireSource(ctx);
      const pageId = Math.round(params.page_id);
      const imgPath = pageIdToPath(sourceDir, pageId);

      if (!existsSync(imgPath)) {
        return {
          content: [{ type: "text", text: `Page ${String(pageId).padStart(4, "0")} not found: ${imgPath}` }],
          details: {},
        };
      }

      const imageData = params.bbox
        ? await cropImageToBase64(imgPath, params.bbox)
        : readFileSync(imgPath).toString("base64");
      const modelId = params.model ?? DEFAULT_MODEL_ID;
      const model = getModel("google", modelId as any);

      const userMessage = {
        role: "user" as const,
        content: [
          { type: "image" as const, data: imageData, mimeType: "image/png" as const },
          { type: "text" as const, text: params.prompt },
        ],
        timestamp: Date.now(),
      };

      const response = await complete(model, {
        systemPrompt: pageExpertPrompt,
        messages: [userMessage],
      });

      // Store the full conversation so follow_up_question can continue it
      state.systemPrompt = pageExpertPrompt;
      state.modelId = modelId;
      state.messages = [userMessage, response];

      const text = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");

      const cost = response.usage?.cost;
      const costStr = cost
        ? ` [cost: $${(cost.input + cost.output + cost.cacheRead).toFixed(4)}]`
        : "";

      const bbox = params.bbox ?? null;

      if (params.output_file) {
        const dataDir = requireSourceDataDir(ctx);
        mkdirSync(dataDir, { recursive: true });
        const outPath = join(dataDir, params.output_file);
        writeFileSync(outPath, text || "(empty response)", "utf-8");
        return {
          content: [{ type: "text", text: `[view p.${pageId}] → ${params.output_file}` }],
          details: { model: modelId, pageId, bbox, cost: costStr, path: outPath },
        };
      }

      return {
        content: [{ type: "text", text: `[view p.${pageId}]\n${text || "(empty response)"}` }],
        details: { model: modelId, pageId, bbox, cost: costStr },
      };
    },
  };
}
