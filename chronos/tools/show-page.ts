import { existsSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { pageIdToPath, listPageIds } from "../utils/page-files.js";
import { sendToExtension } from "../http/http-client.js";
import type { SourceContext } from "./source-context.js";
import { requireSource } from "./source-context.js";

const bboxSchema = Type.Object(
  {
    x: Type.Number({ minimum: 0, maximum: 1 }),
    y: Type.Number({ minimum: 0, maximum: 1 }),
    w: Type.Number({ minimum: 0, maximum: 1 }),
    h: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { description: "Crop region in normalized coordinates (0–1). x/y is the top-left corner, w/h is width/height." }
);

const showPageParams = Type.Object({
  page_id: Type.Number({ description: "The page number (e.g. 1 for page_0001.png)." }),
  bbox: Type.Optional(bboxSchema),
});

export function createShowPageTool(ctx: SourceContext, description: string): ToolDefinition<typeof showPageParams> {
  return {
    name: "show_page",
    label: "Show Page",
    description,
    parameters: showPageParams,
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

      sendToExtension({
        type: "show_page",
        pageId,
        totalPages: listPageIds(sourceDir).length,
        sourceDir,
        sourceName: ctx.sourceName ?? "",
        bbox: params.bbox ?? null,
      });

      const bbox = params.bbox ?? null;
      const viewLink = bbox
        ? `[view p.${pageId}] [view p.${pageId}#sel=${bbox.x},${bbox.y},${bbox.w},${bbox.h}]`
        : `[view p.${pageId}]`;

      return {
        content: [{ type: "text", text: viewLink }],
        details: { pageId, bbox },
      };
    },
  };
}
