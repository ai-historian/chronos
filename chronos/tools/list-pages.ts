import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { listPageIds } from "../utils/page-files.js";
import { sendToExtension } from "../ipc/ipc-client.js";
import type { SourceContext } from "./source-context.js";
import { requireSource } from "./source-context.js";

export function createListPagesTool(ctx: SourceContext, description: string): ToolDefinition {
  return {
    name: "list_pages",
    label: "List Pages",
    description,
    parameters: Type.Object({}),
    async execute() {
      const sourceDir = requireSource(ctx);
      const pages = listPageIds(sourceDir);
      if (pages.length === 0) {
        return {
          content: [{ type: "text", text: "No pages found." }],
          details: {},
        };
      }
      sendToExtension({
        type: "page_list",
        sourceDir,
        sourceName: ctx.sourceName ?? "",
        firstPage: pages[0],
        lastPage: pages[pages.length - 1],
        totalPages: pages.length,
      });

      const first = String(pages[0]).padStart(4, "0");
      const last = String(pages[pages.length - 1]).padStart(4, "0");
      return {
        content: [
          {
            type: "text",
            text:
              `Pages available: ${first} to ${last} ` +
              `(${pages.length} pages total). ` +
              `Files are named page_NNNN.png (4-digit zero-padded).`,
          },
        ],
        details: {},
      };
    },
  };
}
