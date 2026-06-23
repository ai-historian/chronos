import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

import { createSourceContext, type SourceContext } from "../tools/source-context.js";
import { createListPagesTool } from "../tools/list-pages.js";
import { createTaskTool } from "../tools/view-page.js";
import { createShowPageTool } from "../tools/show-page.js";
import { createShowTextTool } from "../tools/show-text.js";
import { createChangeSourceTool } from "../tools/change-source.js";
import { createTaskBatchTool } from "../tools/task-batch.js";
import { createExpertRegistry } from "../tools/expert-registry.js";
import { restoreExpertSessions } from "../tools/expert-turn.js";
import { loadExpertTasks } from "../utils/expert-store.js";
import { loadToolText, loadPromptFile } from "../utils/tool-loader.js";
import { listPageIds } from "../utils/page-files.js";
import { discoverSources } from "../utils/source-discovery.js";
import { ensureWorkspace } from "../utils/workspace.js";
import { saveSessionSource, loadSessionSource } from "../utils/session-source-store.js";
import { getNamedPromptCount, saveSessionName } from "../utils/session-name-store.js";
import { generateSessionTitle } from "../utils/session-namer.js";
import { connectHttp, sendToExtension, disconnectHttp } from "../http/http-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, "..", "..", "prompts");

function readWorkspaceSettings(cwd: string): Record<string, unknown> {
  const settingsPath = join(cwd, ".chronos", "settings.json");
  if (existsSync(settingsPath)) {
    try {
      return JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      return {};
    }
  }
  return {};
}

function writeWorkspaceSettings(cwd: string, settings: Record<string, unknown>) {
  const settingsPath = join(cwd, ".chronos", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

export default function (pi: ExtensionAPI) {
  // Shared mutable source context — updated by /select-source and change_source tool
  const sourceCtx: SourceContext = createSourceContext(null, null, null);

  // ── Register all custom tools ──────────────────────────────────────────

  const expertRegistry = createExpertRegistry();
  const pageExpertPrompt = loadPromptFile("page-expert-prompt.md");

  pi.registerTool(createListPagesTool(sourceCtx, loadToolText("list-pages.md").description));
  pi.registerTool(createTaskTool(sourceCtx, expertRegistry, loadToolText("task.md").description, pageExpertPrompt));
  pi.registerTool(createShowPageTool(sourceCtx, loadToolText("show-page.md").description));
  pi.registerTool(createShowTextTool(sourceCtx, loadToolText("show-text.md").description));
  pi.registerTool(createTaskBatchTool(sourceCtx, expertRegistry, loadToolText("task-batch.md"), pageExpertPrompt));
  pi.registerTool(createChangeSourceTool(sourceCtx, loadToolText("change-source.md").description));

  // ── /select-source command ─────────────────────────────────────────────

  pi.registerCommand("select-source", {
    description: "Browse the workspace sources/ tree and select a source to work with",
    handler: async (args, ctx) => {
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

      // Non-interactive: `/select-source <name>` — the entire args string is
      // the source name (names are relative paths and may contain spaces).
      let source: (typeof sources)[number] | undefined;
      const requestedName = (args ?? "").trim();
      if (requestedName) {
        source = sources.find((s) => s.name === requestedName || basename(s.path) === requestedName);
        if (!source) {
          ctx.ui.notify(`Source "${requestedName}" not found.`, "warning");
          return;
        }
      } else {
        const items = sources.map((s) => `${s.name}  (${listPageIds(s.path).length} pages)`);
        const selected = await ctx.ui.select("Select a source", items);
        if (!selected) return;
        source = sources[items.indexOf(selected)];
      }

      const sourceName = basename(source.path);
      const sourceDataDir = join(workspaceDir, "data", sourceName);
      mkdirSync(sourceDataDir, { recursive: true });

      // Update shared context — all tools pick this up on their next call
      sourceCtx.sourceDir = source.path;
      sourceCtx.sourceName = sourceName;
      sourceCtx.sourceDataDir = sourceDataDir;

      // Remember the choice for this session so resuming restores it (sidecar
      // only — nothing is written to the conversation history).
      saveSessionSource(workspaceDir, ctx.sessionManager.getSessionId(), source.path);

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

  // ── /yolo command ──────────────────────────────────────────────────────

  pi.registerCommand("yolo", {
    description: "Toggle yolo mode — skip bash command confirmations",
    handler: async (_args, ctx) => {
      const settings = readWorkspaceSettings(ctx.cwd);
      const current = settings.yolo === true;
      settings.yolo = !current;
      writeWorkspaceSettings(ctx.cwd, settings);
      ctx.ui.notify(`Yolo mode ${settings.yolo ? "ON" : "OFF"}`, "info");
    },
  });

  // ── Lifecycle events ───────────────────────────────────────────────────

  // Re-establish the source this session last worked on. Restoring only sets
  // the in-memory context (and syncs the viewer over HTTP) — it adds no message
  // to the history, so the model API request is unchanged. The system prompt,
  // rebuilt every turn, then reflects the source on its own.
  const restoreSource = (ctx: ExtensionContext) => {
    const saved = loadSessionSource(ctx.cwd, ctx.sessionManager.getSessionId());
    if (!saved || !applySource(sourceCtx, ctx.cwd, saved)) return;
    sendToExtension({
      type: "show_page",
      pageId: 1,
      totalPages: listPageIds(saved).length,
      sourceDir: saved,
      sourceName: sourceCtx.sourceName!,
      bbox: null,
    });
  };

  // Rebuild this session's persisted expert (task/task_batch) conversations so
  // task_id follow-ups keep working across agent restarts and session resumes.
  const restoreExperts = async (ctx: ExtensionContext) => {
    try {
      const persisted = loadExpertTasks(ctx.cwd, ctx.sessionManager.getSessionId());
      if (persisted.length) await restoreExpertSessions(expertRegistry, ctx, persisted);
    } catch (err) {
      console.warn("[chronos] expert restore failed:", (err as Error).message);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    ensureWorkspace(ctx.cwd);
    // .chronos/.env holds workspace API keys (e.g. GEMINI_API_KEY) — the
    // expert models read them from the environment (and we need them to
    // re-resolve expert models when restoring sessions).
    dotenvConfig({ path: join(ctx.cwd, ".chronos", ".env") });
    connectHttp();
    restoreSource(ctx);
    await restoreExperts(ctx);
  });

  // Switching/resuming a session swaps the active source and experts: clear the
  // in-memory state, then restore whatever the target session had (no-op if none).
  pi.on("session_switch", async (_event, ctx) => {
    sourceCtx.sourceDir = null;
    sourceCtx.sourceName = null;
    sourceCtx.sourceDataDir = null;
    expertRegistry.sessions.clear();
    expertRegistry.nextId = 1;
    restoreSource(ctx);
    await restoreExperts(ctx);
  });

  pi.on("session_shutdown", async () => {
    disconnectHttp();
  });

  // Auto-generate a short session title from the user's prompts (once, cached in
  // a sidecar) so the history list shows something better than the truncated
  // first message. Best-effort and non-blocking: fire-and-forget so it never
  // delays the next prompt, and silently keeps the fallback on any failure.
  pi.on("agent_end", async (_event, ctx) => {
    void maybeNameSession(ctx);
  });

  pi.on("session_directory", async (event) => {
    return { sessionDir: join(event.cwd, "sessions") };
  });

  // ── System prompt injection (every turn) ───────────────────────────────

  pi.on("before_agent_start", async (_event, ctx) => {
    return { systemPrompt: buildChronosSystemPrompt(sourceCtx, ctx.cwd) };
  });

  // Note: chat/tool streaming (text deltas, tool start/end, turn end) reaches
  // the VS Code panel over RPC AgentEvents. HTTP carries only viewer events
  // (show_page / page_list / show_text from the viewer tools), so there are no
  // streaming hooks here.

  // ── Bash confirmation hook ─────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const settings = readWorkspaceSettings(ctx.cwd);
    if (settings.yolo === true) return;
    const approved = await ctx.ui.confirm(
      "Bash Command",
      `Allow: ${event.input.command}`,
    );
    if (!approved) {
      return { block: true, reason: "User denied bash command" };
    }
  });
}

// Point the shared context at a source directory without touching the model
// conversation. Returns false if the path is no longer a valid source (e.g.
// deleted since it was saved), leaving the context unchanged.
function applySource(sourceCtx: SourceContext, workspaceDir: string, sourcePath: string): boolean {
  if (!existsSync(sourcePath) || !existsSync(join(sourcePath, "png"))) return false;
  const sourceName = basename(sourcePath);
  const sourceDataDir = join(workspaceDir, "data", sourceName);
  mkdirSync(sourceDataDir, { recursive: true });
  sourceCtx.sourceDir = sourcePath;
  sourceCtx.sourceName = sourceName;
  sourceCtx.sourceDataDir = sourceDataDir;
  return true;
}

// ── Session auto-naming ─────────────────────────────────────────────────────

function textOfMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((b): b is { type: "text"; text: string } => (b as any)?.type === "text")
      .map((b) => b.text);
    if (parts.length) return parts.join(" ");
  }
  return undefined;
}

// Genuine user prompts from a session, in order. Skips the synthetic
// "Source selected: …" follow-up the /select-source command injects.
function userPromptsFromSession(entries: { type: string; [k: string]: any }[]): string[] {
  const prompts: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "user") continue;
    const text = textOfMessageContent(message.content)?.trim();
    if (!text || text.startsWith("Source selected:")) continue;
    prompts.push(text);
  }
  return prompts;
}

// Refine the title over the first few prompts, then lock it, so a session named
// after one terse opener still gets a better label as its task takes shape.
const NAMING_PROMPT_CAP = 3;
// In-process guard so two near-simultaneous agent_end events don't both fire a
// generation before either has written its result.
const namingInFlight = new Set<string>();

// Generate-and-cache a display name for the current session from its user
// prompts, unless the user named it explicitly or it's already named from at
// least this many prompts. Never throws.
async function maybeNameSession(ctx: ExtensionContext): Promise<void> {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return;
    if (ctx.sessionManager.getSessionName()) return; // user set a name explicitly
    if (namingInFlight.has(sessionId)) return; // a generation is already running
    const prompts = userPromptsFromSession(ctx.sessionManager.getEntries());
    if (prompts.length === 0) return;
    const target = Math.min(prompts.length, NAMING_PROMPT_CAP);
    if (getNamedPromptCount(ctx.cwd, sessionId) >= target) return; // already named from enough prompts

    namingInFlight.add(sessionId);
    try {
      const title = await generateSessionTitle(ctx.modelRegistry, prompts);
      if (title) saveSessionName(ctx.cwd, sessionId, title, target);
    } finally {
      namingInFlight.delete(sessionId);
    }
  } catch (err) {
    console.warn("[chronos] session auto-name failed:", (err as Error).message);
  }
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
