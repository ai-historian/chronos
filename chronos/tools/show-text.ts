import { existsSync, readFileSync } from "node:fs";
import { resolve, isAbsolute, join, basename } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { sendToExtension } from "../http/http-client.js";
import type { SourceContext } from "./source-context.js";
import { requireSource } from "./source-context.js";

const showTextParams = Type.Object({
  file_path: Type.String({
    description: "Path to the text file. Absolute, or relative to the source directory.",
  }),
  highlight: Type.Optional(
    Type.String({
      description:
        "A text passage to highlight and scroll to. Must be an exact substring of the file content.",
    })
  ),
});

export function createShowTextTool(ctx: SourceContext, description: string): ToolDefinition<typeof showTextParams> {
  return {
    name: "show_text",
    label: "Show Text",
    description,
    parameters: showTextParams,
    async execute(_toolCallId, params) {
      const sourceDir = requireSource(ctx);
      const filePath = isAbsolute(params.file_path)
        ? params.file_path
        : resolve(join(sourceDir, params.file_path));

      if (!existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `File not found: ${filePath}` }],
          details: {},
        };
      }

      const content = readFileSync(filePath, "utf-8");
      const highlightFound =
        params.highlight == null || content.includes(params.highlight);

      sendToExtension({
        type: "show_text",
        filePath,
        content,
        highlight: params.highlight ?? null,
        sourceName: ctx.sourceName ?? basename(filePath),
      });

      return {
        content: [
          {
            type: "text",
            text: highlightFound
              ? `Showing ${params.file_path} in the viewer.`
              : `Showing ${params.file_path} — highlight passage not found in file.`,
          },
        ],
        details: { filePath, highlight: params.highlight ?? null },
      };
    },
  };
}
