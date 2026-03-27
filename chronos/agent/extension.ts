import type { ExtensionAPI, ToolCallEventResult, BashToolCallEvent } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import * as readline from "node:readline";
import { createListPagesTool } from "./tools/list-pages.js";
import { createAnalyzePageTool } from "./tools/view-page.js";
import { createShowPageTool } from "./tools/show-page.js";
import { createShowTextTool } from "./tools/show-text.js";
import { createFollowUpQuestionTool } from "./tools/follow-up-question.js";
import { createChangeSourceTool } from "./tools/change-source.js";
import { createAskPagesBatchTool } from "./tools/ask-pages-batch.js";
import { createPageExpertState } from "./tools/page-expert-state.js";
import type { SourceContext } from "./tools/source-context.js";
import { loadToolText, loadPromptFile } from "./utils/tool-loader.js";

/** Create all custom tools for a given source context. */
export function createTools(ctx: SourceContext, dataDir: string): ToolDefinition<any>[] {
  const pageExpertState = createPageExpertState();
  const pageExpertPrompt = loadPromptFile("page-expert-prompt.md");

  return [
    createListPagesTool(ctx, loadToolText("list-pages.md").description),
    createAnalyzePageTool(ctx, pageExpertState, loadToolText("ask-page.md").description, pageExpertPrompt),
    createFollowUpQuestionTool(pageExpertState, loadToolText("follow-up-question.md").description),
    createShowPageTool(ctx, loadToolText("show-page.md").description),
    createShowTextTool(ctx, loadToolText("show-text.md").description),
    createAskPagesBatchTool(ctx, loadToolText("ask-pages-batch.md"), pageExpertPrompt),
    createChangeSourceTool(ctx, dataDir, loadToolText("change-source.md").description),
  ];
}

/**
 * Holds the ExtensionAPI reference after the extension factory runs.
 * Used to register skill tools on-demand after session creation.
 */
export interface ExtensionHandle {
  /** Register additional tools (e.g. from a skill's index.ts). */
  registerTools(tools: ToolDefinition<any>[]): void;
}

/**
 * Pi extension factory. Registers all custom tools and captures
 * the ExtensionAPI reference for later skill tool registration.
 */
function confirmBashCommand(command: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`\n🔒 Bash: ${command}\nAllow? [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

export function createExtensionFactory(ctx: SourceContext, dataDir: string, handle: ExtensionHandle) {
  return (pi: ExtensionAPI) => {
    for (const tool of createTools(ctx, dataDir)) {
      pi.registerTool(tool);
    }

    // Require user confirmation for bash tool calls
    pi.on("tool_call", async (event): Promise<ToolCallEventResult | undefined> => {
      if (!isToolCallEventType("bash", event)) return;
      const approved = await confirmBashCommand(event.input.command);
      if (!approved) {
        return { block: true, reason: "User denied bash command" };
      }
    });

    // Wire up the handle so callers can register tools later
    handle.registerTools = (tools) => {
      for (const tool of tools) {
        pi.registerTool(tool);
      }
    };
  };
}
