import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { listPageIds } from "../utils/page-files.js";
import type { SourceContext } from "./source-context.js";

const changeSourceParams = Type.Object({
  source_path: Type.String({
    description: "Absolute path to the source directory (must contain a png/ subdirectory).",
  }),
});

export function createChangeSourceTool(ctx: SourceContext, description: string): ToolDefinition<typeof changeSourceParams> {
  return {
    name: "change_source",
    label: "Change Source",
    description,
    parameters: changeSourceParams,
    async execute(_toolCallId, params, _signal, _onUpdate, extCtx: ExtensionContext) {
      const sourcePath = params.source_path;
      const workspaceDir = extCtx.cwd;

      if (!existsSync(sourcePath)) {
        return {
          content: [{ type: "text", text: `Source path does not exist: ${sourcePath}` }],
          details: {},
        };
      }

      const pngDir = join(sourcePath, "png");
      if (!existsSync(pngDir)) {
        return {
          content: [{ type: "text", text: `Not a valid source — no png/ subdirectory found at: ${sourcePath}` }],
          details: {},
        };
      }

      // Update shared context
      ctx.sourceDir = sourcePath;
      ctx.sourceName = basename(sourcePath);
      ctx.sourceDataDir = join(workspaceDir, "data", ctx.sourceName!);
      mkdirSync(ctx.sourceDataDir, { recursive: true });

      // Gather info about the source
      const pages = listPageIds(sourcePath);
      const pageCount = pages.length;

      // Load per-source memory if it exists
      const memoryPath = join(workspaceDir, "memory", `${ctx.sourceName!}.md`);
      let documentMemory = "";
      if (existsSync(memoryPath)) {
        documentMemory = readFileSync(memoryPath, "utf-8").trim();
      }

      const parts: string[] = [
        `Switched to source: "${ctx.sourceName}" at ${sourcePath}`,
        `Pages: ${pageCount}`,
        `Source data dir: ${ctx.sourceDataDir}`,
        `Source memory: ${memoryPath}`,
      ];
      if (documentMemory) {
        parts.push(`\nDocument memory:\n${documentMemory}`);
      } else {
        parts.push("No document memory yet.");
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: { sourcePath, sourceName: ctx.sourceName, pageCount },
      };
    },
  };
}
