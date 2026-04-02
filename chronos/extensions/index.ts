import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createSourceContext, type SourceContext } from "../tools/source-context.js";
import { createListPagesTool } from "../tools/list-pages.js";
import { createAnalyzePageTool } from "../tools/view-page.js";
import { createShowPageTool } from "../tools/show-page.js";
import { createShowTextTool } from "../tools/show-text.js";
import { createFollowUpQuestionTool } from "../tools/follow-up-question.js";
import { createChangeSourceTool } from "../tools/change-source.js";
import { createAskPagesBatchTool } from "../tools/ask-pages-batch.js";
import { createPageExpertState } from "../tools/page-expert-state.js";
import { loadToolText, loadPromptFile } from "../utils/tool-loader.js";
import { listPageIds } from "../utils/page-files.js";
import { discoverSources } from "../utils/source-discovery.js";
import { ensureWorkspace } from "../utils/workspace.js";
import { connectHttp, sendToExtension, disconnectHttp } from "../http/http-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, "..", "prompts");

export default function (pi: ExtensionAPI) {
  // Shared mutable source context — updated by /select-source and change_source tool
  const sourceCtx: SourceContext = createSourceContext(null, null, null);

  // ── Register all custom tools ──────────────────────────────────────────

  const pageExpertState = createPageExpertState();
  const pageExpertPrompt = loadPromptFile("page-expert-prompt.md");

  pi.registerTool(createListPagesTool(sourceCtx, loadToolText("list-pages.md").description));
  pi.registerTool(createAnalyzePageTool(sourceCtx, pageExpertState, loadToolText("ask-page.md").description, pageExpertPrompt));
  pi.registerTool(createFollowUpQuestionTool(pageExpertState, loadToolText("follow-up-question.md").description));
  pi.registerTool(createShowPageTool(sourceCtx, loadToolText("show-page.md").description));
  pi.registerTool(createShowTextTool(sourceCtx, loadToolText("show-text.md").description));
  pi.registerTool(createAskPagesBatchTool(sourceCtx, loadToolText("ask-pages-batch.md"), pageExpertPrompt));
  pi.registerTool(createChangeSourceTool(sourceCtx, loadToolText("change-source.md").description));

  // ── /select-source command ─────────────────────────────────────────────

  pi.registerCommand("select-source", {
    description: "Browse the workspace sources/ tree and select a source to work with",
    handler: async (_args, ctx) => {
      const workspaceDir = ctx.cwd;
      const sourcesDir = join(workspaceDir, "sources");
      const sources = discoverSources(sourcesDir);

      if (sources.length === 0) {
        ctx.ui.notify(
          "No sources found. Add a directory with a png/ subfolder under sources/.",
          "warning",
        );
        return;
      }

      const items = sources.map((s) => `${s.name}  (${listPageIds(s.path).length} pages)`);
      const selected = await ctx.ui.select("Select a source", items);
      if (!selected) return;

      const idx = items.indexOf(selected);
      const source = sources[idx];
      const sourceName = basename(source.path);
      const sourceDataDir = join(workspaceDir, "data", sourceName);
      mkdirSync(sourceDataDir, { recursive: true });

      // Update shared context — all tools pick this up on their next call
      sourceCtx.sourceDir = source.path;
      sourceCtx.sourceName = sourceName;
      sourceCtx.sourceDataDir = sourceDataDir;

      // Show the first page in the VS Code viewer if IPC is active
      sendToExtension({
        type: "show_page",
        pageId: 1,
        totalPages: listPageIds(source.path).length,
        sourceDir: source.path,
        sourceName,
        bbox: null,
      });

      // Inform the model so it acknowledges the new source
      pi.sendUserMessage(
        `Source selected: "${sourceName}" at ${source.path}. ` +
          `Please acknowledge and confirm you are ready to work with this source.`,
        { deliverAs: "followUp" },
      );

      ctx.ui.notify(`Source: ${sourceName}`, "info");
    },
  });

  // ── Lifecycle events ───────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    ensureWorkspace(ctx.cwd);
    connectHttp();
  });

  pi.on("session_shutdown", async () => {
    disconnectHttp();
  });

  pi.on("session_directory", async (event) => {
    return { sessionDir: join(event.cwd, "sessions") };
  });

  // ── System prompt injection (every turn) ───────────────────────────────

  pi.on("before_agent_start", async (_event, ctx) => {
    return { systemPrompt: buildChronosSystemPrompt(sourceCtx, ctx.cwd) };
  });

  // ── IPC streaming ─────────────────────────────────────────────────────

  pi.on("message_update", async (event) => {
    const e = event.assistantMessageEvent;
    if (e.type === "text_delta") {
      sendToExtension({ type: "text_delta", delta: e.delta });
    }
  });

  pi.on("tool_execution_start", async (event) => {
    const argsStr = JSON.stringify(event.args).slice(0, 200);
    sendToExtension({ type: "tool_start", toolName: event.toolName, args: argsStr });
  });

  pi.on("tool_execution_end", async (event) => {
    const result = event.result;
    const resultText =
      typeof result === "object" && result?.content
        ? (result.content as any[])
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("")
        : String(result);
    sendToExtension({ type: "tool_end", toolName: event.toolName, result: resultText.slice(0, 500) });
  });

  pi.on("agent_end", async () => {
    sendToExtension({ type: "turn_end" });
  });

  // ── Bash confirmation hook ─────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const approved = await ctx.ui.confirm(
      "Bash Command",
      `Allow: ${event.input.command}`,
    );
    if (!approved) {
      return { block: true, reason: "User denied bash command" };
    }
  });
}

// ── System prompt builder ──────────────────────────────────────────────

function buildChronosSystemPrompt(sourceCtx: SourceContext, cwd: string): string {
  const memoryDir = join(cwd, "memory");
  const skillsDir = join(cwd, "skills");
  const dataDir = join(cwd, "data");
  const template = readFileSync(join(PROMPTS_DIR, "system-prompt.md"), "utf-8");

  const resolvedSourceDir = sourceCtx.sourceDir ?? "(no source selected — use /select-source)";
  const resolvedSourceName = sourceCtx.sourceName ?? "(no source selected)";
  const sourceDataDir = sourceCtx.sourceDataDir ?? "(no source selected)";
  const sourceMemoryPath = sourceCtx.sourceName
    ? join(memoryDir, `${sourceCtx.sourceName}.md`)
    : "(no source selected)";

  let documentMemory = "";
  if (sourceCtx.sourceName) {
    const mp = join(memoryDir, `${sourceCtx.sourceName}.md`);
    if (existsSync(mp)) documentMemory = readFileSync(mp, "utf-8").trim();
  }

  let globalMemory = "";
  const gmp = join(memoryDir, "MEMORY.MD");
  if (existsSync(gmp)) globalMemory = readFileSync(gmp, "utf-8").trim();

  return template
    .replaceAll("{{workspaceDir}}", cwd)
    .replaceAll("{{sourceDir}}", resolvedSourceDir)
    .replaceAll("{{sourceName}}", resolvedSourceName)
    .replaceAll("{{memoryDir}}", memoryDir)
    .replaceAll("{{sourceMemoryPath}}", sourceMemoryPath)
    .replaceAll("{{sourceDataDir}}", sourceDataDir)
    .replaceAll("{{skillsDir}}", skillsDir)
    .replaceAll("{{dataDir}}", dataDir)
    .replaceAll("{{documentMemory}}", documentMemory)
    .replaceAll("{{globalMemory}}", globalMemory);
}
