# Chronos → Pi Package Migration

This document is a step-by-step guide for converting the Chronos standalone agent into a
pi-package. After the migration, users install Chronos via `pi install` and run it through the
standard `pi` CLI. All existing tools, skills, and VS Code integration remain functional.

---

## Table of Contents

1. [Why Migrate?](#why-migrate)
2. [Core Design Changes](#core-design-changes)
3. [What Changes, What Stays](#what-changes-what-stays)
4. [New Package Layout](#new-package-layout)
5. [Step-by-Step Migration](#step-by-step-migration)
   - [Step 1 – Create the new package skeleton](#step-1--create-the-new-package-skeleton)
   - [Step 2 – Move tool and utility files](#step-2--move-tool-and-utility-files)
   - [Step 3 – Write the extension entry point](#step-3--write-the-extension-entry-point)
   - [Step 4 – The /select-source command](#step-4--the-select-source-command)
   - [Step 5 – Workspace init in session_start](#step-5--workspace-init-in-session_start)
   - [Step 6 – System prompt via before_agent_start](#step-6--system-prompt-via-before_agent_start)
   - [Step 7 – Rewrite the system prompt template](#step-7--rewrite-the-system-prompt-template)
   - [Step 8 – IPC streaming via pi events](#step-8--ipc-streaming-via-pi-events)
   - [Step 9 – Bash confirmation hook](#step-9--bash-confirmation-hook)
   - [Step 10 – Migrate skills](#step-10--migrate-skills)
   - [Step 11 – Remove deleted files](#step-11--remove-deleted-files)
   - [Step 12 – Update package.json](#step-12--update-packagejson)
6. [VS Code Extension Changes](#vs-code-extension-changes)
7. [What Is Lost and Why It's Fine](#what-is-lost-and-why-its-fine)
8. [User-Facing Workflow After Migration](#user-facing-workflow-after-migration)

---

## Why Migrate?

Currently Chronos is a standalone binary that reimplements substantial infrastructure that pi
already provides: session management, TUI rendering, model selection, the interactive REPL,
`/compact`, `/tree`, conversation history, and more. As a pi-package:

- All of that infrastructure is inherited for free and stays up to date.
- Users get pi's full feature set (model switching, session branching, `/compact`, keyboard
  shortcuts, etc.) without Chronos having to maintain any of it.
- Chronos tools and skills become composable with any other pi package installed by the user.
- Installation is a single `pi install` command instead of a separate npm global install.
- The VS Code extension continues to work without changes to the IPC protocol.

---

## Core Design Changes

The current design requires `--source` and `--workspace` flags at startup, and builds the system
prompt once at session creation. The new design is simpler:

**Workspace = cwd.** When the user runs `pi` from inside a Chronos workspace directory, the
extension detects the workspace from `ctx.cwd`. No `--workspace` flag is needed.

**Source selection at runtime via `/select-source`.** Instead of a `--source` flag, a
`/select-source` command walks the workspace's `sources/` directory, presents a tree of available
sources with page counts, and lets the user pick one interactively. The selection updates the
shared `SourceContext` and informs the model. The existing `change_source` tool remains for cases
where the model switches sources on its own.

**System prompt via `before_agent_start`.** The Chronos system prompt (SOUL, workspace
conventions, tool descriptions, memory, current source state) is injected on every turn via the
`before_agent_start` event hook. The workspace root is always `ctx.cwd`. The template is
rewritten to explain the workspace folder structure, the VS Code integration features, and all
Chronos tools — so the agent understands the full environment it is operating in.

---

## What Changes, What Stays

| Concern | Current | After migration |
|---|---|---|
| Entry point | `chronos` binary (`agent/index.ts`) | Removed — user runs `pi` |
| Custom tools | `extension.ts` + `tools/*.ts` | `extensions/index.ts` (same ExtensionAPI) |
| `--source` flag | `parseArgs()` in `config.ts` | Removed — use `/select-source` command |
| `--workspace` flag | `parseArgs()` in `config.ts` | Removed — workspace is `ctx.cwd` |
| `--task` flag | `parseArgs()` | Removed — use `/skill:name` (pi standard) |
| `--model` flag | `parseArgs()` | Removed — use pi's native `--model` / `/model` |
| Source selection | Startup flag | `/select-source` command (interactive, runtime) |
| Workspace root | Flag value or `DEFAULT_WORKSPACE` | Always `ctx.cwd` |
| System prompt | Built once in `create-session.ts` | Injected every turn via `before_agent_start` |
| System prompt content | Focused on dynamic state | Extended: explains folder structure, VS Code integration, all tools |
| Workspace init | `ensureWorkspace()` in `index.ts` | `session_start` event handler |
| Session directory | `<workspace>/sessions/` via custom `SessionManager` | `session_directory` event → `<cwd>/sessions/` |
| VS Code IPC | Connected unconditionally in `index.ts` | Connected in `session_start` if `CHRONOS_IPC_SOCKET` is set |
| IPC streaming | `session.subscribe()` in `index.ts` | `message_update` / `tool_execution_start/end` events |
| Skills | User-authored in `<workspace>/skills/` | Shipped built-in skills in `skills/` + user workspace skills |
| Bash confirmation | `tool_call` hook in `extension.ts` | Same |
| `noExtensions: true` | Blocks all other extensions | Dropped — composability is a feature |
| `agentsFilesOverride` | Blocks pi's AGENTS.md discovery | Dropped — pi discovers workspace files normally |

---

## New Package Layout

```
chronos/
├── package.json
├── tsconfig.json
├── extensions/
│   └── index.ts          ← NEW: pi extension entry point (replaces agent/index.ts + extension.ts)
├── tools/                ← moved from agent/tools/ verbatim
│   ├── ask-pages-batch.ts
│   ├── change-source.ts
│   ├── follow-up-question.ts
│   ├── list-pages.ts
│   ├── page-expert-state.ts
│   ├── show-page.ts
│   ├── show-text.ts
│   ├── source-context.ts
│   └── view-page.ts
├── utils/                ← moved from agent/utils/ verbatim
│   ├── crop-image.ts
│   ├── page-files.ts
│   ├── source-discovery.ts
│   ├── source-folder.ts
│   ├── tool-loader.ts
│   └── workspace.ts
├── ipc/                  ← moved from agent/ipc/ verbatim
│   └── ipc-client.ts
├── prompts/              ← moved from agent/prompts/; system-prompt.md is rewritten
│   ├── ask-page.md
│   ├── ask-pages-batch.md
│   ├── change-source.md
│   ├── follow-up-question.md
│   ├── list-pages.md
│   ├── page-expert-prompt.md
│   ├── show-page.md
│   ├── show-text.md
│   ├── soul.md           ← default soul (still used as fallback)
│   └── system-prompt.md  ← REWRITTEN (see Step 7)
└── skills/               ← NEW: built-in shipped skills
```

Files deleted:
- `agent/index.ts`
- `agent/config.ts`
- `agent/create-session.ts`
- `agent/system-prompt.ts`
- `agent/extension.ts`
- `agent/prompts/agents.md` — replaced by pi's own AGENTS.md discovery

---

## Step-by-Step Migration

### Step 1 – Create the new package skeleton

```bash
cd chronos/

mkdir -p extensions skills

mv agent/tools   tools
mv agent/utils   utils
mv agent/ipc     ipc
mv agent/prompts prompts
```

---

### Step 2 – Move tool and utility files

All files under `tools/`, `utils/`, and `ipc/` are moved verbatim. The only thing that breaks is
import paths. Because `tools/` is now at the package root rather than under `agent/`, fix the
relative imports:

- In `tools/*.ts`: `../ipc/ipc-client.js` → `../../ipc/ipc-client.js`  
- In `tools/*.ts`: `../utils/` → `../../utils/`

Run a project-wide find-and-replace on just the moved files. No logic changes are needed.

---

### Step 3 – Write the extension entry point

Create `extensions/index.ts`. This is the single file pi loads as a pi extension. It must export
a default function that receives `ExtensionAPI`. All the logic from `agent/index.ts` and
`agent/extension.ts` moves here.

The top-level structure:

```typescript
// extensions/index.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createSourceContext, type SourceContext } from "../tools/source-context.js";
import { createListPagesTool }        from "../tools/list-pages.js";
import { createAnalyzePageTool }      from "../tools/view-page.js";
import { createShowPageTool }         from "../tools/show-page.js";
import { createShowTextTool }         from "../tools/show-text.js";
import { createFollowUpQuestionTool } from "../tools/follow-up-question.js";
import { createChangeSourceTool }     from "../tools/change-source.js";
import { createAskPagesBatchTool }    from "../tools/ask-pages-batch.js";
import { createPageExpertState }      from "../tools/page-expert-state.js";
import { loadToolText, loadPromptFile } from "../utils/tool-loader.js";
import { listPageIds }                from "../utils/page-files.js";
import { ensureWorkspace }            from "../utils/workspace.js";
import { connectIpc, sendToExtension, disconnectIpc } from "../ipc/ipc-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const PROMPTS_DIR = join(__dirname, "..", "prompts");

export default function (pi: ExtensionAPI) {
  // Shared mutable source context — updated by /select-source and change_source tool
  const sourceCtx: SourceContext = createSourceContext(null, null, null);

  // Register all custom tools
  const pageExpertState = createPageExpertState();
  const pageExpertPrompt = loadPromptFile("page-expert-prompt.md");

  // Tools are registered once here; they close over sourceCtx and read
  // ctx.cwd at execute-time for the workspace root.
  // See Steps 4–9 for events and commands.

  // ... (see subsequent steps for event hooks and the /select-source command)
}
```

The `sourceCtx` object is the single piece of mutable state shared between all tools and the
`/select-source` command. Mutating it is safe because tools read it at `execute()` time.

Register tools inside the default function exactly as in the current `extension.ts`, pointing
`createChangeSourceTool` at `ctx.cwd` (read at execute time, not at load time — see note in
Step 4).

---

### Step 4 – The `/select-source` command

Register a `/select-source` command that walks the workspace's `sources/` directory, lets the
user pick a source interactively, updates `sourceCtx`, and informs the model.

```typescript
// Inside the default export function, after registering tools:

function discoverSources(workspaceDir: string): Array<{ label: string; path: string }> {
  const sourcesDir = join(workspaceDir, "sources");
  const results: Array<{ label: string; path: string }> = [];

  function walk(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }

    if (existsSync(join(dir, "png")) && statSync(join(dir, "png")).isDirectory()) {
      const pages = listPageIds(dir).length;
      const rel   = dir.slice(sourcesDir.length + 1);          // relative to sources/
      results.push({ label: `${rel}  (${pages} pages)`, path: dir });
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory() && !entry.startsWith(".")) walk(full);
      } catch { /* skip unreadable */ }
    }
  }

  walk(sourcesDir);
  return results.sort((a, b) => a.label.localeCompare(b.label));
}

pi.registerCommand("select-source", {
  description: "Browse the workspace sources/ tree and select a source to work with",
  handler: async (_args, ctx) => {
    const workspaceDir = ctx.cwd;
    const sources = discoverSources(workspaceDir);

    if (sources.length === 0) {
      ctx.ui.notify(
        "No sources found. Add a directory with a png/ subfolder under sources/.",
        "warning"
      );
      return;
    }

    const items = sources.map(s => s.label);
    const selected = await ctx.ui.select("Select a source", items);
    if (!selected) return;

    const source = sources.find(s => s.label === selected)!;
    const sourceName    = basename(source.path);
    const sourceDataDir = join(workspaceDir, "data", sourceName);
    mkdirSync(sourceDataDir, { recursive: true });

    // Update shared context — all tools pick this up on their next call
    sourceCtx.sourceDir     = source.path;
    sourceCtx.sourceName    = sourceName;
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
      { deliverAs: "followUp" }
    );

    ctx.ui.notify(`Source: ${sourceName}`, "success");
  },
});
```

**Why `pi.sendUserMessage` instead of a tool call:** Commands run outside the agent loop.
`sendUserMessage` with `deliverAs: "followUp"` queues the message to be delivered once the agent
is idle, triggering a new turn where the model acknowledges the switch. The model then knows to
use the source-specific tools without being told again.

**`change_source` tool stays:** The tool is still needed for when the model switches sources
programmatically (e.g., when processing multiple sources in a task). It reads `ctx.cwd` at
execute time to find the workspace root:

```typescript
// In createChangeSourceTool, replace the hardcoded dataDir parameter with a
// dataDir getter that reads ctx.cwd at execute time.
// Pass a function () => join(ctx.cwd, "data") instead of the pre-resolved dataDir string.
// This avoids the need for the --workspace flag.
```

---

### Step 5 – Workspace init in `session_start`

Move `ensureWorkspace()` into `session_start`. The workspace root is `ctx.cwd`.

Also connect the IPC client here (conditionally — `connectIpc()` already checks for the
`CHRONOS_IPC_SOCKET` environment variable).

```typescript
pi.on("session_start", async (_event, ctx) => {
  ensureWorkspace(ctx.cwd);
  connectIpc();
});

pi.on("session_shutdown", async (_event, _ctx) => {
  disconnectIpc();
});
```

Redirect session storage so Chronos sessions stay inside the workspace rather than pi's global
session directory:

```typescript
pi.on("session_directory", async (event) => {
  // event.cwd is available at this early startup hook
  return { sessionDir: join(event.cwd, "sessions") };
});
```

---

### Step 6 – System prompt via `before_agent_start`

Inject the full Chronos system prompt on every turn. The workspace root is `ctx.cwd`. Source
state comes from `sourceCtx` (the shared closure variable). Memory files are re-read on each
turn, so changes the agent made in the previous turn are visible immediately.

```typescript
import { readFileSync, existsSync } from "node:fs";

function buildChronosSystemPrompt(sourceCtx: SourceContext, cwd: string): string {
  const chronosDir = join(cwd, ".chronos");
  const memoryDir  = join(cwd, "memory");
  const skillsDir  = join(cwd, "skills");
  const dataDir    = join(cwd, "data");

  function loadWithFallback(primary: string, fallback: string): string {
    return readFileSync(existsSync(primary) ? primary : fallback, "utf-8").trim();
  }

  const soul     = loadWithFallback(join(chronosDir, "SOUL.MD"), join(PROMPTS_DIR, "soul.md"));
  const template = readFileSync(join(PROMPTS_DIR, "system-prompt.md"), "utf-8");

  const resolvedSourceDir  = sourceCtx.sourceDir  ?? "(no source selected — use /select-source)";
  const resolvedSourceName = sourceCtx.sourceName ?? "(no source selected)";
  const sourceDataDir      = sourceCtx.sourceDataDir ?? "(no source selected)";
  const sourceMemoryPath   = sourceCtx.sourceName
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
    .replaceAll("{{soul}}",             soul)
    .replaceAll("{{workspaceDir}}",     cwd)
    .replaceAll("{{sourceDir}}",        resolvedSourceDir)
    .replaceAll("{{sourceName}}",       resolvedSourceName)
    .replaceAll("{{memoryDir}}",        memoryDir)
    .replaceAll("{{sourceMemoryPath}}", sourceMemoryPath)
    .replaceAll("{{sourceDataDir}}",    sourceDataDir)
    .replaceAll("{{skillsDir}}",        skillsDir)
    .replaceAll("{{dataDir}}",          dataDir)
    .replaceAll("{{documentMemory}}",   documentMemory)
    .replaceAll("{{globalMemory}}",     globalMemory);
}

pi.on("before_agent_start", async (_event, ctx) => {
  return { systemPrompt: buildChronosSystemPrompt(sourceCtx, ctx.cwd) };
});
```

---

### Step 7 – Rewrite the system prompt template

The current `system-prompt.md` assumes the agent understands the workspace structure implicitly.
Rewrite it to explicitly explain:

1. What a Chronos workspace is and how its folders relate to each other
2. VS Code extension features the agent can use (page viewer, `[view p.N]` links)
3. Every available Chronos tool with usage guidance
4. The memory system
5. The current source state

Below is the full structure of the new `system-prompt.md`:

```markdown
{{soul}}

## What you are

You are running inside a Chronos workspace. Chronos is a document digitization environment for
historical sources (scanned city directories, registries, etc.). You help analyze page images,
extract structured data, and build up knowledge about archival sources.

You are NOT a general coding agent. You use file tools only to read/write outputs and memory —
not to write application code.

## Workspace layout

Your working directory IS the workspace root: `{{workspaceDir}}`

| Directory | Purpose |
|-----------|---------|
| `sources/` | Input: scanned source directories. Each contains a `png/` subfolder with page images named `page_NNNN.png`. |
| `data/` | Output: per-source extraction results, summaries, JSON. Write all outputs here. |
| `memory/` | Your persistent memory. `MEMORY.MD` for cross-source insights. `<source-name>.md` for per-source findings. |
| `skills/` | Task instructions. Each skill is a `SKILL.md` file in a named subdirectory. |
| `sessions/` | Conversation history (auto-managed, do not edit). |
| `.chronos/` | Workspace identity: `SOUL.MD` (your personality), `AGENTS.md` (conventions), `.env` (API key). |

**Source data** for the current source goes in `{{sourceDataDir}}/`.
Never write output files directly into the source directory (`{{sourceDir}}/`).

## VS Code integration

If you are running inside VS Code via the Chronos extension, a page viewer panel is open
alongside your terminal. You can interact with it:

- **`show_page`** — displays a specific page in the viewer (no analysis, instant).
- **`list_pages`** — lists available pages AND updates the viewer's page-range indicator.
- **`ask_page`** — after analysis, the tool emits a `[view p.N]` link in the terminal.
  The user can click it to jump to that page in the viewer.
- **`[view p.N]` links** — any time you write `[view p.N]` in your response (e.g.
  `[view p.42]`), it becomes a clickable link in the terminal that opens page 42.

Use these affordances freely. The viewer updates in real time as you call tools.

## Available tools

### Source navigation
- **`/select-source`** *(user command)* — interactive source picker. The user types this to
  choose which source to work on. It updates your source context automatically.
- **`change_source(source_path)`** — switch to a different source programmatically. Use this
  when a task requires processing multiple sources.
- **`list_pages`** — list all page IDs in the current source. Always call this first when
  starting work on a new source to understand the page range.

### Page analysis
- **`ask_page(page_id, prompt, [model], [output_file], [bbox])`** — send a page image to a
  specialist vision model with a prompt. Returns a text analysis. Starts a new conversation —
  use `follow_up_question` to continue without re-sending the image.
- **`follow_up_question(prompt)`** — continue the last `ask_page` conversation. Use for
  clarifications like "What did that abbreviation mean?" or "Which entries were ambiguous?".
- **`ask_pages_batch(page_ids, prompt, [model], [output_file], [concurrency], [bbox])`** —
  process many pages in parallel. **Requires explicit user confirmation before calling.**
  See the mandatory protocol below.
- **`show_page(page_id, [bbox])`** — display a page in the VS Code viewer without analyzing it.

### File tools
- **`read`**, **`edit`**, **`write`**, **`grep`**, **`find`**, **`ls`** — standard file tools.
  - Use `read` for text files only. Never `read` a PNG — use `ask_page` instead.
  - Use `grep`/`find`/`ls` for file exploration (faster than `read` for discovery).
  - Use `edit` for precise surgical changes (oldText must match exactly).
  - Use `write` only for new files or complete rewrites.

## Mandatory Confirmation Protocol — `ask_pages_batch`

`ask_pages_batch` is high-cost and irreversible. Follow this protocol every time, without
exception:

1. **Propose** — In a single message with no tool calls: state the intent, exact page range,
   the full prompt in a code block, the model and rationale, and the output plan.
2. **Ask** — End the message with an explicit go/no-go question.
3. **Stop** — End your turn. Do not call any tools. Wait for the user's reply.
4. **Execute** — Only after receiving explicit confirmation (e.g. "yes", "go ahead").

## Memory system

Memory is how you persist knowledge across sessions. Write early and often.

### Global memory: `{{memoryDir}}/MEMORY.MD`
Cross-source insights: recurring conventions, abbreviation patterns, lessons learned,
tool tips. Update this after any session where you learned something reusable.

### Per-source memory: `{{sourceMemoryPath}}`
Everything about the current source: table of contents, page ranges for sections,
layout observations, content insights, anomalies, progress notes.

Write after every ~5–10 pages analyzed. Do not wait until the end of a task.
Always `read` before writing, then use `edit` to append.

### Current global memory
{{globalMemory}}

### Current source memory
{{documentMemory}}

## Current source

Source name: **{{sourceName}}**
Source path: `{{sourceDir}}`
Source data: `{{sourceDataDir}}/`
Source memory: `{{sourceMemoryPath}}`

Skills directory: `{{skillsDir}}/`
```

The key additions over the old template are:
- **Workspace layout table** — the agent understands every folder's purpose
- **VS Code integration section** — explains the page viewer, clickable links, how tools interact with it
- **Expanded tool reference** — every tool with parameters and usage notes in one place
- **Global memory** injected alongside source memory
- Dropped the AGENTS.md variable substitution — pi now discovers `.chronos/AGENTS.md` natively
  (or the user can put it in `.pi/AGENTS.md`); no need to inject it manually

---

### Step 8 – IPC streaming via pi events

Replace the `session.subscribe()` block in `index.ts` with pi event handlers. The IPC client
module is unchanged — it already gates all sends on the socket being connected.

```typescript
pi.on("message_update", async (event, _ctx) => {
  const e = event.assistantMessageEvent;
  if (e.type === "text_delta") {
    sendToExtension({ type: "text_delta", delta: e.delta });
  }
});

pi.on("tool_execution_start", async (event, _ctx) => {
  const argsStr = JSON.stringify(event.args).slice(0, 200);
  sendToExtension({ type: "tool_start", toolName: event.toolName, args: argsStr });
});

pi.on("tool_execution_end", async (event, _ctx) => {
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

pi.on("agent_end", async (_event, _ctx) => {
  sendToExtension({ type: "turn_end" });
});
```

---

### Step 9 – Bash confirmation hook

This is unchanged from the current `extension.ts`. Keep it as-is:

```typescript
pi.on("tool_call", async (event, _ctx) => {
  if (!isToolCallEventType("bash", event)) return;
  const approved = await confirmBashCommand(event.input.command);
  if (!approved) return { block: true, reason: "User denied bash command" };
});

function confirmBashCommand(command: string): Promise<boolean> {
  // readline confirmation as in current extension.ts
}
```

---

### Step 10 – Migrate skills

**Built-in skills** that should ship with the package go in `skills/`. Pi auto-discovers them
from this conventional directory. The `SKILL.md` format is already fully compatible with the
pi Agent Skills standard — no changes needed.

**User-authored skills** should go in `.pi/skills/` or `.agents/skills/` inside the workspace,
or the user can add their workspace `skills/` directory to their pi settings:

```json
{ "skills": ["./skills"] }
```

**Skills with `index.ts` custom tools:** The old system dynamically imported a skill's
`index.ts` at task activation time. Pi does not support this. The recommended approach is to
move any skill-specific tools into the main extension in `extensions/index.ts`. Since all
Chronos skills share `SourceContext`, the tools belong in the extension anyway. If a skill's
tools are truly standalone, they can be a separate pi extension in a sub-package.

---

### Step 11 – Remove deleted files

```bash
rm agent/index.ts
rm agent/config.ts
rm agent/create-session.ts
rm agent/system-prompt.ts
rm agent/extension.ts
rm agent/prompts/agents.md    # replaced by native AGENTS.md discovery
rmdir agent/                  # if empty
```

---

### Step 12 – Update `package.json`

```json
{
  "name": "@you/chronos",
  "version": "1.1.0",
  "description": "AI agent for digitizing historical German city directories",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills":     ["./skills"],
    "prompts":    ["./prompts"]
  },
  "peerDependencies": {
    "@mariozechner/pi-ai":           "*",
    "@mariozechner/pi-coding-agent": "*",
    "@sinclair/typebox":             "*"
  },
  "dependencies": {
    "dotenv":  "^16.4.0",
    "sharp":   "^0.34.5"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx":         "^4.19.0",
    "typescript":  "^5.7.0"
  },
  "scripts": {
    "build": "tsc"
  }
}
```

Key changes from the current `package.json`:

- **Remove** `"bin"` — no `chronos` command.
- **Remove** `"files": ["dist/"]` and the build-time prompt copy — prompts are loaded from
  source by pi's jiti loader, no compilation step needed during development.
- **Add** `"keywords": ["pi-package"]` for gallery discoverability.
- **Add** `"pi"` manifest pointing at `extensions/`, `skills/`, `prompts/`.
- **Move** `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` to `peerDependencies` —
  pi bundles these; listing them as regular `dependencies` would cause duplicate modules.
- **Keep** `sharp` and `dotenv` in `dependencies` — these are not bundled by pi.

---

## VS Code Extension Changes

The VS Code extension (`chronos-vscode/`) requires **no changes to the IPC protocol**
(`protocol.ts` is unchanged) and **no changes to the page viewer**.

The only change is in `extension.ts`: the `startSession` command no longer needs to pass
`--source` or `--workspace` flags. The workspace is the open VS Code folder (already `cwd`).
Source selection happens via `/select-source` at runtime.

**Before:**
```typescript
shellArgs: [
  "npx", "chronos",
  "--source", sourceDir,
  "--workspace", workspaceFolder,
]
```

**After:**
```typescript
shellArgs: ["pi"]   // or: ["npx", "@mariozechner/pi-coding-agent"]
```

The terminal is already opened with `cwd: workspaceFolder` so pi starts in the right directory.
The `CHRONOS_IPC_SOCKET` env var is still set so IPC connects automatically.

The source picker UI in the extension (`showQuickPick` in the current `startSession` command) is
no longer needed — source selection moved into the pi TUI via `/select-source`. The
**Chronos: Start Agent Session** command becomes simpler: just open a terminal running `pi`.

The page viewer still opens on page 1 when the IPC receives a `show_page` message from the
`/select-source` command (see Step 4), so the VS Code workflow is seamless.

---

## What Is Lost and Why It's Fine

**`noExtensions: true`**
Dropping this means the user's global/project pi extensions also load. That is the desired
behavior — composability. If a user's extension conflicts with a Chronos tool name, they can
filter packages via pi settings.

**`agentsFilesOverride`**
Pi now discovers `.chronos/AGENTS.md` (or `.pi/AGENTS.md`) normally. The workspace conventions
the agent needs come from two places: the `system-prompt.md` template (injected via
`before_agent_start`) and the workspace's own `AGENTS.md` file. Both coexist cleanly.

**`--task` flag**
Replaced by `/skill:name`. This is strictly better: it shows in autocomplete, describes the
skill, and is consistent with any other pi skill package.

**`--model` flag**
Pi supports `--model` natively. The flag is not lost — it just comes from pi instead of custom
`parseArgs()` code.

**The `chronos` binary**
Users run `pi` instead. For users who want the old `chronos` alias:
```bash
#!/bin/sh
exec pi "$@"
```

---

## User-Facing Workflow After Migration

**Install:**
```bash
pi install npm:@you/chronos
# or from a local checkout:
pi install ./path/to/chronos
```

**Run from a workspace directory:**
```bash
cd ~/my-chronos-workspace
pi
```

Pi starts, the extension initializes the workspace if needed, and the agent is ready.

**Select a source:**
```
/select-source
```

A picker appears with all sources found under `sources/`. After selection the agent
acknowledges the source and is ready to work.

**Run a skill:**
```
/skill:extract-entries
```

**VS Code:**
Open the workspace folder in VS Code, run **Chronos: Start Agent Session**. The extension opens
a terminal running `pi` in the workspace directory with `CHRONOS_IPC_SOCKET` set. Type
`/select-source` to pick a source — the page viewer opens automatically.
