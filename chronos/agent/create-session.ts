import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  readTool,
  editTool,
  writeTool,
  grepTool,
  findTool,
  lsTool,
  bashTool
} from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { createExtensionFactory, type ExtensionHandle } from "./extension.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createSourceContext, type SourceContext } from "./tools/source-context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE = join(__dirname, "..", "data");

export interface SessionResult {
  session: AgentSession;
  sourceContext: SourceContext;
  extensionHandle: ExtensionHandle;
  sessionId: string;
  sessionFile: string | undefined;
}

/**
 * Create an agent session.
 * `sourceDir` is optional — when null, the agent starts without a source
 * and the user must use `change_source` to select one.
 * Sessions are always stored in `<dataDir>/sessions/`.
 */
export async function createSession(
  sourceDir: string | null,
  model?: string,
  dataDir?: string,
  sessionPath?: string
): Promise<SessionResult> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not set. Add it to .env or export it.");
  }

  const resolvedDataDir = dataDir ?? DEFAULT_WORKSPACE;
  const sourceName = sourceDir ? basename(sourceDir) : null;

  const sourceDataDir = sourceName ? join(resolvedDataDir, "data", sourceName) : null;
  const ctx = createSourceContext(sourceDir, sourceName, sourceDataDir);

  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey("google", process.env.GEMINI_API_KEY);

  const modelRegistry = new ModelRegistry(authStorage);
  const modelId = model ?? "gemini-3.1-pro-preview";
  const orchestratorModel = getModel("google", modelId as any);

  const cwd = sourceDir ?? resolvedDataDir;

  const extensionHandle: ExtensionHandle = {
    registerTools: () => { throw new Error("Extension not yet initialized"); },
  };

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    extensionFactories: [createExtensionFactory(ctx, resolvedDataDir, extensionHandle)],
    noExtensions: true,
    systemPrompt: buildSystemPrompt(sourceDir, sourceName, resolvedDataDir),
    // Disable pi's CLAUDE.md discovery — all context comes from the workspace
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  });
  await resourceLoader.reload();

  const sessionsDir = join(resolvedDataDir, "sessions");

  const sessionManager = sessionPath
    ? SessionManager.open(sessionPath, sessionsDir)
    : SessionManager.create(cwd, sessionsDir);

  const { session } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    model: orchestratorModel,
    thinkingLevel: "low",
    tools: [readTool, editTool, writeTool, grepTool, findTool, lsTool, bashTool],
    sessionManager,
    resourceLoader,
  });

  return {
    session,
    sourceContext: ctx,
    extensionHandle,
    sessionId: sessionManager.getSessionId(),
    sessionFile: sessionManager.getSessionFile() ?? undefined,
  };
}
