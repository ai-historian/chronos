import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { complete, getModel, StringEnum } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { pageIdToPath } from "../utils/page-files.js";
import type { SourceContext } from "./source-context.js";
import { requireSource, requireSourceDataDir } from "./source-context.js";
import type { ToolText } from "../utils/tool-loader.js";
import { cropImageToBase64, type Bbox } from "../utils/crop-image.js";

const DEFAULT_MODEL_ID = "gemini-3-flash-preview";

interface PageResult {
  page_id: number;
  status: "ok" | "error";
  response?: string;
  file?: string;
  error?: string;
  cost?: string;
}

async function analyzeSinglePage(
  sourceDir: string,
  outputDir: string,
  pageId: number,
  prompt: string,
  modelId: string,
  outputFileTemplate: string | undefined,
  systemPrompt: string,
  bbox?: Bbox,
): Promise<PageResult> {
  const imgPath = pageIdToPath(sourceDir, pageId);
  const padded = String(pageId).padStart(4, "0");

  if (!existsSync(imgPath)) {
    return { page_id: pageId, status: "error", error: `Page ${padded} not found: ${imgPath}` };
  }

  try {
    const imageData = bbox
      ? await cropImageToBase64(imgPath, bbox)
      : readFileSync(imgPath).toString("base64");
    const model = getModel("google", modelId as any);

    const response = await complete(model, {
      systemPrompt,
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "image" as const, data: imageData, mimeType: "image/png" as const },
            { type: "text" as const, text: prompt },
          ],
          timestamp: Date.now(),
        },
      ],
    });

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");

    const cost = response.usage?.cost;
    const costStr = cost
      ? `$${(cost.input + cost.output + cost.cacheRead).toFixed(4)}`
      : undefined;

    if (outputFileTemplate) {
      const filename = outputFileTemplate.replace("{page_id}", padded);
      const outPath = join(outputDir, filename);
      writeFileSync(outPath, text || "(empty response)", "utf-8");
      return { page_id: pageId, status: "ok", file: filename, cost: costStr };
    }

    return { page_id: pageId, status: "ok", response: text || "(empty response)", cost: costStr };
  } catch (e) {
    return { page_id: pageId, status: "error", error: (e as Error).message };
  }
}

const askPagesBatchParams = Type.Object({
  page_ids: Type.Array(Type.Number(), {
    description:
      "Array of page IDs to analyze (e.g. [42, 43, 44]). " +
      "These are file-system indices, not printed page numbers.",
  }),
  prompt: Type.String({ description: "The prompt to send to the vision model for each page." }),
  model: Type.Optional(
    StringEnum(
      ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro", "gemini-3-flash-preview", "gemini-3.1-pro-preview"] as const,
      { description: `Gemini model to use. Default: ${DEFAULT_MODEL_ID}` },
    ),
  ),
  output_file: Type.Optional(
    Type.String({
      description:
        "File name template with a {page_id} placeholder (e.g. 'entries_{page_id}.json'). " +
        "Each page result is written to a separate file in the source directory. " +
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
      { description: "Crop region in normalized coordinates (0–1). Applied to every page before sending to the vision model." }
    )
  ),
});

export function createAskPagesBatchTool(
  ctx: SourceContext,
  toolText: ToolText,
  pageExpertPrompt: string,
): ToolDefinition<typeof askPagesBatchParams> {
  return {
    name: "ask_pages_batch",
    label: "Ask Pages (Batch)",
    description: toolText.description,
    promptGuidelines: toolText.promptGuidelines,
    parameters: askPagesBatchParams,
    async execute(_toolCallId, params, signal) {
      const sourceDir = requireSource(ctx);
      const outputDir = requireSourceDataDir(ctx);
      mkdirSync(outputDir, { recursive: true });
      const pageIds = params.page_ids.map((id) => Math.round(id));
      const modelId = params.model ?? DEFAULT_MODEL_ID;
      const concurrency = params.concurrency ?? 4;
      const outputFileTemplate = params.output_file;
      const bbox = params.bbox;

      // Validate output_file template
      if (outputFileTemplate && !outputFileTemplate.includes("{page_id}")) {
        return {
          content: [{ type: "text", text: "output_file must contain {page_id} placeholder (e.g. 'entries_{page_id}.json')." }],
          details: {},
        };
      }

      if (pageIds.length === 0) {
        return {
          content: [{ type: "text", text: "No page IDs provided." }],
          details: {},
        };
      }

      const results: PageResult[] = [];
      let completed = 0;

      // Process pages with concurrency limit
      const queue = [...pageIds];
      const workers: Promise<void>[] = [];

      for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
        workers.push(
          (async () => {
            while (queue.length > 0) {
              if (signal?.aborted) return;
              const pageId = queue.shift()!;
              const result = await analyzeSinglePage(sourceDir, outputDir, pageId, params.prompt, modelId, outputFileTemplate, pageExpertPrompt, bbox);
              results.push(result);
              completed++;
            }
          })(),
        );
      }

      await Promise.all(workers);

      // Sort results by page_id for consistent output
      results.sort((a, b) => a.page_id - b.page_id);

      const okCount = results.filter((r) => r.status === "ok").length;
      const errCount = results.filter((r) => r.status === "error").length;
      const totalCost = results
        .filter((r) => r.cost)
        .reduce((sum, r) => sum + parseFloat(r.cost!.replace("$", "")), 0);

      const summary = [
        `Batch complete: ${okCount}/${pageIds.length} succeeded` +
          (errCount > 0 ? `, ${errCount} failed` : "") +
          (totalCost > 0 ? ` [total cost: $${totalCost.toFixed(4)}]` : ""),
      ];

      if (outputFileTemplate) {
        summary.push(`Files written to source directory using pattern: ${outputFileTemplate}`);
      }

      // For inline results, include them in the response
      const content = outputFileTemplate
        ? summary.join("\n")
        : summary.join("\n") + "\n\n" + JSON.stringify(results, null, 2);

      return {
        content: [{ type: "text", text: content }],
        details: { results, model: modelId, concurrency },
      };
    },
  };
}
