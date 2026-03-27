import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE = join(__dirname, "..", "..", "data");

const DEFAULT_SOUL = `You are a helpful document analysis agent. You help users by analyzing scanned pages, answering questions, extracting structured data, and building up knowledge about sources.

You are *NOT a coding agent*. You will use coding tools, but only for the purpose of analyzing documents, answering questions, or fulfilling tasks you are given.`;

const DEFAULT_AGENTS = `# AGENTS.md - Your Workspace

This folder is home. Treat it that way.

## Session Startup

Before doing anything else:

1. Read \`SOUL.md\` — this is who you are
2. Read \`memory/YYYY-MM-DD.md\` (today + yesterday) for recent context
3. Read \`MEMORY.md\` for long-term context

Don't ask permission. Just do it.

## Memory

You wake up fresh each session. These files are your continuity:

- **Daily notes:** \`memory/YYYY-MM-DD.md\` (create \`memory/\` if needed) — raw logs of what happened
- **Long-term:** \`MEMORY.md\` — your curated memories, distilled essence of what matters

Capture what matters. Decisions, context, things to remember.

### MEMORY.md - Your Long-Term Memory

- You can **read, edit, and update** MEMORY.md freely
- Write significant events, decisions, lessons learned
- This is your curated memory — not raw logs
- Over time, review your daily files and update MEMORY.md with what's worth keeping

### Write It Down - No "Mental Notes"!

- **Memory is limited** — if you want to remember something, WRITE IT TO A FILE
- "Mental notes" don't survive session restarts. Files do.
- When you learn a lesson → document it so future-you doesn't repeat it
- **Text > Brain**

## Writing to Memory — Do It Proactively

You must actively persist what you learn. Nobody will remind you. There are two memory files and each has a clear purpose:

### Workspace Memory: \`MEMORY.md\`

For general-purpose insights, lessons, and decisions that apply across sources. Examples: conventions you've established, tool usage tips, patterns you've noticed across multiple documents.

**When to write:** after any session where you learned something reusable.

### Per-Source Document Memory: \`memory/<source-name>.md\`

For everything you learn about a specific source document — structure, page ranges, section boundaries, observations about content, anomalies. This is shared across runs for the same source.

**When to write:** after inspecting a meaningful number of pages (~5–10), persist your findings so far. Do not wait until the end of a task — write incrementally. If a session is interrupted, anything not written is lost.

**How to write:** prefer \`edit\` to surgically add new findings. Only use \`write\` if the file doesn't exist yet or you need a full restructure. Always \`read\` first.

**What to write:** concise, structured notes. Page ranges, section labels, observations. Not raw transcriptions or verbose commentary.

## Red Lines

- Don't run destructive commands without asking.
- When in doubt, ask.

## Make It Yours

This is a starting point. Add your own conventions, style, and rules as you figure out what works.`;

/** Recursively copy src → dst, skipping files that already exist at dst. */
function copyMissing(src: string, dst: string) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyMissing(srcPath, dstPath);
    } else if (!existsSync(dstPath)) {
      copyFileSync(srcPath, dstPath);
    }
  }
}

/** Write a file only if it doesn't already exist. */
function writeIfMissing(filePath: string, content: string) {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, content, "utf-8");
  }
}

/**
 * Ensure the workspace has the required structure.
 * If it doesn't exist or is missing folders/files, scaffold from the default workspace.
 * Memory files are created from built-in defaults if neither the default workspace
 * nor the target workspace has them. Existing files are never overwritten.
 */
export function ensureWorkspace(workspaceDir: string) {
  const isNew = !existsSync(workspaceDir) || readdirSync(workspaceDir).length === 0;

  mkdirSync(join(workspaceDir, "sources"), { recursive: true });
  mkdirSync(join(workspaceDir, "skills"), { recursive: true });

  // .chronos/ holds agent identity files (SOUL.MD, AGENTS.md)
  const chronosDir = join(workspaceDir, ".chronos");
  mkdirSync(chronosDir, { recursive: true });
  writeIfMissing(join(chronosDir, "SOUL.MD"), DEFAULT_SOUL);
  writeIfMissing(join(chronosDir, "AGENTS.md"), DEFAULT_AGENTS);

  // memory/ holds workspace-level MEMORY.MD and per-source document memory
  const memoryDst = join(workspaceDir, "memory");
  mkdirSync(memoryDst, { recursive: true });
  writeIfMissing(join(memoryDst, "MEMORY.MD"), "");

  if (isNew) {
    console.log(`Workspace initialized at: ${workspaceDir}`);
  }
}
