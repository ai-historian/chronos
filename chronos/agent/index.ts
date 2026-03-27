#!/usr/bin/env node
import { config } from "dotenv";
config();

import { existsSync } from "node:fs";
import { join } from "node:path";
import { InteractiveMode } from "@mariozechner/pi-coding-agent";
import { parseArgs } from "./config.js";
import { validateSourceDir } from "./utils/source-folder.js";
import { createSession } from "./create-session.js";
import { ensureWorkspace } from "./utils/workspace.js";
import { connectIpc, disconnectIpc, sendToExtension } from "./ipc/ipc-client.js";

async function main() {
  const args = parseArgs();
  ensureWorkspace(args.workspace);
  const ipcActive = connectIpc();

  let sourceDir: string;
  try {
    sourceDir = validateSourceDir(args.sourceDir);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const { session, sourceContext, extensionHandle } = await createSession(sourceDir, args.model, args.workspace);
  const sourceName = sourceContext.sourceName ?? sourceDir;

  // Forward IPC display events when connected to the extension
  if (ipcActive) {
    session.subscribe((event) => {
      if (event.type === "message_update") {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") {
          sendToExtension({ type: "text_delta", delta: e.delta });
        }
      } else if (event.type === "tool_execution_start") {
        const argsStr = JSON.stringify(event.args).slice(0, 200);
        sendToExtension({ type: "tool_start", toolName: event.toolName, args: argsStr });
      } else if (event.type === "tool_execution_end") {
        const resultText =
          typeof event.result === "object" && event.result?.content
            ? event.result.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("")
            : String(event.result);
        sendToExtension({ type: "tool_end", toolName: event.toolName, result: resultText.slice(0, 500) });
      }
    });
  }

  if (args.task) {
    // Load skill tools if the skill has an index.ts
    const skillIndex = join(args.workspace, "skills", args.task, "index.ts");
    if (existsSync(skillIndex)) {
      try {
        const mod = await import(skillIndex);
        if (typeof mod.createTools === "function") {
          extensionHandle.registerTools(mod.createTools(sourceContext));
        }
      } catch (e) {
        console.error(`Failed to load skill tools:`, (e as Error).message);
      }
    }

    const initialPrompt = `Use the ${args.task} skill. Source: ${sourceName}`;
    try {
      await session.prompt(initialPrompt);
    } catch (e) {
      const msg = (e as Error).message;
      console.error("\nAgent error:", msg);
      sendToExtension({ type: "error", message: msg });
    }
    sendToExtension({ type: "turn_end" });
  } else {
    // Use pi's full TUI for interactive mode
    const mode = new InteractiveMode(session);
    await mode.run();
  }

  disconnectIpc();
  session.dispose();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
