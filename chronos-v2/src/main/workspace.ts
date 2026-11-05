import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// Electron is lazy-required inside the pickers so this module loads under plain Node (tests).

function writeIfMissing(filePath: string, content: string): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, content, "utf-8");
  }
}

export async function initWorkspace(folder: string): Promise<void> {
  // Create directory structure
  for (const dir of ["sources", "memory", "skills", "sessions", ".chronos", ".pi"]) {
    mkdirSync(join(folder, dir), { recursive: true });
  }

  // Bridge the workspace-level skills/ dir into pi's resource discovery
  // (pi auto-discovers from .pi/skills only; we point it at ../skills instead).
  writeIfMissing(
    join(folder, ".pi", "settings.json"),
    JSON.stringify({ skills: ["../skills"] }, null, 2) + "\n",
  );

  // Memory files
  writeIfMissing(join(folder, "memory", "MEMORY.MD"), "");

  // README
  writeIfMissing(join(folder, "README.md"),
`# Chronos Workspace

This folder is a Chronos workspace for digitizing historical documents.

## Structure

\`\`\`
sources/          Place your source directories here (each with a png/ subfolder)
data/             Per-source extraction results and outputs
memory/           Agent memory files (MEMORY.MD, per-source notes)
skills/           Skill definitions (markdown task instructions)
sessions/         Agent session logs (auto-generated)
.chronos/.env     Provider API keys (set via "Chronos: Connect AI Provider")
\`\`\`

## Getting Started

1. **Install Chronos**: \`pi install chronos\`

2. **Add a source**: Create a folder inside \`sources/\` with a \`png/\` subfolder containing page images.
   Pages should be named \`page_NNNN.png\` (4-digit zero-padded, 1-indexed).

   Example:
   \`\`\`
   sources/Frankfurt_1864/png/page_0001.png
   sources/Frankfurt_1864/png/page_0002.png
   ...
   \`\`\`

   Or use **"Chronos: Import Sources"** to import PDFs and images automatically.

3. **Start a session**: Open the Command Palette (\`Ctrl+Shift+P\`) and run
   **"Chronos: Start Agent Session"**. This opens the Chronos panel (page viewer
   + chat) in the workspace.

4. **Select a source**: Pick a source from the header dropdown, or type
   \`/select-source\` in the chat. The page viewer opens automatically.

5. **Browse pages**: Run **"Chronos: Show Page"** to jump the viewer to a
   specific page.

## AI provider

Chronos works with any provider \`pi\` supports (Anthropic, Google, OpenAI, …).
Click **Log in** in the Chronos panel header — or run **"Chronos: Connect AI
Provider"** — to store an API key in \`.chronos/.env\`. You can also edit that
file directly (e.g. \`ANTHROPIC_API_KEY=...\`).
`
  );

  // Auth is provider-agnostic and set up from the panel ("Log in" button, or the
  // "Chronos: Connect AI Provider" command), which writes a <PROVIDER>_API_KEY
  // into .chronos/.env. Just ensure the file exists so there's somewhere to write.
  const chronosDir = join(folder, ".chronos");
  const envPath = join(chronosDir, ".env");
  if (!existsSync(envPath)) {
    mkdirSync(chronosDir, { recursive: true });
    writeFileSync(envPath, "# Provider API keys, e.g. ANTHROPIC_API_KEY=... or GEMINI_API_KEY=...\n", "utf-8");
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isChronosWorkspace(folder: string): boolean {
  return isDir(join(folder, "sources")) || isDir(join(folder, ".chronos"));
}

export interface RecentItem {
  path: string;
  openedAt: number;
}

const RECENT_MAX = 10;

export class RecentStore {
  constructor(private readonly file: string) {}

  private read(): RecentItem[] {
    try {
      const j = JSON.parse(readFileSync(this.file, "utf-8"));
      if (!j || !Array.isArray(j.items)) return [];
      return j.items.filter(
        (i: unknown): i is RecentItem =>
          !!i && typeof (i as RecentItem).path === "string" && typeof (i as RecentItem).openedAt === "number",
      );
    } catch {
      return [];
    }
  }

  list(): RecentItem[] {
    return this.read().filter((i) => isDir(i.path));
  }

  add(path: string): void {
    const p = resolve(path);
    const items = [{ path: p, openedAt: Date.now() }, ...this.list().filter((i) => i.path !== p)].slice(0, RECENT_MAX);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify({ items }, null, 2), "utf-8");
    renameSync(tmp, this.file);
  }
}

/** Ask for a folder; if it is not yet a Chronos workspace, offer to initialise it. */
async function pickAndMaybeInit(parent: Electron.BrowserWindow | null, title: string, offerInit: boolean): Promise<string | null> {
  const { dialog } = require("electron") as typeof import("electron");
  const opts: Electron.OpenDialogOptions = { title, properties: ["openDirectory", "createDirectory"] };
  const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || r.filePaths.length === 0) return null;
  const folder = resolve(r.filePaths[0]);
  if (isChronosWorkspace(folder)) return folder;
  if (offerInit) {
    const mopts: Electron.MessageBoxOptions = {
      type: "question",
      message: "Not a Chronos workspace. Initialise it?",
      detail: basename(folder) + "\n" + folder,
      buttons: ["Initialise", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    };
    const m = parent ? await dialog.showMessageBox(parent, mopts) : await dialog.showMessageBox(mopts);
    if (m.response !== 0) return null;
  }
  try {
    await initWorkspace(folder);
  } catch (e) {
    dialog.showErrorBox("Could not initialise workspace", e instanceof Error ? e.message : String(e));
    return null;
  }
  return folder;
}

export function pickWorkspaceToOpen(parent: Electron.BrowserWindow | null): Promise<string | null> {
  return pickAndMaybeInit(parent, "Open Chronos workspace", true);
}

export function pickFolderToCreate(parent: Electron.BrowserWindow | null): Promise<string | null> {
  return pickAndMaybeInit(parent, "Choose a folder for the new workspace", false);
}
