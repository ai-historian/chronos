import * as vscode from "vscode";
import * as path from "path";
import { readdirSync, statSync, existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpus } from "node:os";

const execFileAsync = promisify(execFile);
import { IpcServer } from "./ipc-server";
import { PageViewerProvider } from "./page-viewer";

function countPages(sourceDir: string): number {
  const pngDir = join(sourceDir, "png");
  try {
    return readdirSync(pngDir).filter(
      (f) => f.startsWith("page_") && /\.(png|jpg|jpeg)$/i.test(f)
    ).length;
  } catch {
    return 0;
  }
}

interface SourceInfo {
  name: string;
  path: string;
}

function discoverSources(rootDir: string): SourceInfo[] {
  const sources: SourceInfo[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    if (existsSync(join(dir, "png")) && statSync(join(dir, "png")).isDirectory()) {
      sources.push({ name: relative(rootDir, dir), path: dir });
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory() && !entry.startsWith(".")) {
          walk(full);
        }
      } catch {
        // skip unreadable
      }
    }
  }

  walk(rootDir);
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

function readEnvFile(envPath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!existsSync(envPath)) return vars;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match) vars[match[1]] = match[2].trim();
  }
  return vars;
}

function writeIfMissing(filePath: string, content: string): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, content, "utf-8");
  }
}

async function initWorkspace(folder: string): Promise<boolean> {
  // Create directory structure
  for (const dir of ["sources", "memory", "skills", "sessions", ".chronos"]) {
    mkdirSync(join(folder, dir), { recursive: true });
  }

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
.chronos/.env     API keys (GEMINI_API_KEY)
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
   **"Chronos: Start Agent Session"**. This opens a \`pi\` terminal in the workspace.

4. **Select a source**: Type \`/select-source\` in the terminal to pick a source.
   The page viewer opens automatically.

5. **Browse pages**: Run **"Chronos: Show Page"** to open the page viewer
   independently.

## API Key

Your Gemini API key is stored in \`.chronos/.env\`. You can edit it there
or re-run **"Chronos: Init Workspace"** to set a new one.
`
  );

  // Ask for Gemini API key
  const envPath = join(folder, ".chronos", ".env");
  let apiKey: string | undefined;

  if (existsSync(envPath)) {
    const overwrite = await vscode.window.showQuickPick(["Keep existing key", "Enter new key"], {
      placeHolder: "A Gemini API key already exists. What would you like to do?",
    });
    if (overwrite === "Enter new key") {
      apiKey = await vscode.window.showInputBox({
        prompt: "Enter your Gemini API key",
        password: true,
        placeHolder: "AIza...",
      });
    }
  } else {
    apiKey = await vscode.window.showInputBox({
      prompt: "Enter your Gemini API key (required for agent to work)",
      password: true,
      placeHolder: "AIza...",
    });
  }

  if (apiKey !== undefined) {
    writeFileSync(envPath, `GEMINI_API_KEY=${apiKey}\n`, "utf-8");
  }

  return true;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"]);
const SUPPORTED_EXTS = new Set([...IMAGE_EXTS, ".pdf", ".txt"]);

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

interface ImportResult {
  imported: number;
  skipped: string[];
  errors: string[];
}

async function importFile(
  filePath: string,
  sourcesDir: string,
  progress: (msg: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const ext = extname(filePath).toLowerCase();
  const sourceName = stripExt(basename(filePath));
  const sourceDir = join(sourcesDir, sourceName);

  if (existsSync(sourceDir)) {
    return { ok: false, error: `Source "${sourceName}" already exists, skipping` };
  }

  if (ext === ".pdf") {
    const pngDir = join(sourceDir, "png");
    mkdirSync(pngDir, { recursive: true });
    progress(`Converting PDF: ${sourceName}...`);
    try {
      // Get page count
      let totalPages = 0;
      try {
        const { stdout } = await execFileAsync("mutool", ["info", filePath]);
        const match = stdout.match(/^Pages:\s+(\d+)/m);
        if (match) totalPages = parseInt(match[1], 10);
      } catch {
        // Fall through — single-shot conversion below
      }

      if (totalPages <= 1) {
        // Single page or unknown count — convert in one call
        progress(`Converting PDF: ${sourceName}...`);
        await execFileAsync("mutool", [
          "draw", "-o", join(pngDir, "page_%04d.png"), "-r", "200", "-q", filePath,
        ], { maxBuffer: 10 * 1024 * 1024 });
      } else {
        // Split into chunks and convert in parallel
        const workers = Math.min(cpus().length, totalPages);
        const chunkSize = Math.ceil(totalPages / workers);
        let completed = 0;

        const chunks: { start: number; end: number }[] = [];
        for (let i = 0; i < totalPages; i += chunkSize) {
          chunks.push({ start: i + 1, end: Math.min(i + chunkSize, totalPages) });
        }

        progress(`Converting PDF: ${sourceName} (${totalPages} pages, ${chunks.length} workers)...`);

        await Promise.all(chunks.map(async ({ start, end }) => {
          await execFileAsync("mutool", [
            "draw", "-o", join(pngDir, "page_%04d.png"), "-r", "200", "-q",
            filePath, `${start}-${end}`,
          ], { maxBuffer: 10 * 1024 * 1024 });
          completed += end - start + 1;
          progress(`Converting PDF: ${sourceName} (${completed}/${totalPages} pages)...`);
        }));
      }

      return { ok: true };
    } catch (err) {
      return { ok: false, error: `PDF conversion failed for "${sourceName}": ${(err as Error).message}` };
    }
  }

  if (IMAGE_EXTS.has(ext)) {
    const pngDir = join(sourceDir, "png");
    mkdirSync(pngDir, { recursive: true });
    progress(`Importing image: ${sourceName}`);
    copyFileSync(filePath, join(pngDir, `page_0001${ext}`));
    return { ok: true };
  }

  if (ext === ".txt") {
    mkdirSync(sourceDir, { recursive: true });
    progress(`Importing text: ${sourceName}`);
    copyFileSync(filePath, join(sourceDir, basename(filePath)));
    return { ok: true };
  }

  return { ok: false, error: `Unsupported file type: ${ext}` };
}

async function importSources(
  folderPath: string,
  sourcesDir: string,
): Promise<ImportResult> {
  const files = readdirSync(folderPath)
    .filter((f) => {
      const ext = extname(f).toLowerCase();
      return SUPPORTED_EXTS.has(ext) && !f.startsWith(".");
    })
    .map((f) => join(folderPath, f))
    .filter((f) => statSync(f).isFile());

  if (files.length === 0) {
    return { imported: 0, skipped: [], errors: ["No supported files found (pdf, txt, png, jpg, jpeg, tif, tiff, bmp)"] };
  }

  const result: ImportResult = { imported: 0, skipped: [], errors: [] };

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Chronos: Importing sources",
      cancellable: false,
    },
    async (progress) => {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const name = basename(file);
        progress.report({
          message: `(${i + 1}/${files.length}) ${name}`,
          increment: (100 / files.length),
        });

        const res = await importFile(
          file,
          sourcesDir,
          (msg) => progress.report({ message: `(${i + 1}/${files.length}) ${msg}` }),
        );

        if (res.ok) {
          result.imported++;
        } else if (res.error?.includes("already exists")) {
          result.skipped.push(name);
        } else {
          result.errors.push(res.error ?? `Failed: ${name}`);
        }
      }
    }
  );

  return result;
}

export function activate(context: vscode.ExtensionContext): void {
  // The open VS Code folder IS the workspace (data dir)
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const ipcServer = new IpcServer();
  const pageViewer = new PageViewerProvider(workspaceFolder);

  ipcServer.onMessage((msg) => {
    switch (msg.type) {
      case "show_page":
        pageViewer.showPage(msg.sourceDir, msg.sourceName, msg.pageId, msg.bbox, msg.totalPages);
        break;
      case "page_list":
        pageViewer.setPageRange(msg.firstPage, msg.lastPage);
        break;
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("chronos.startSession", async () => {
      if (!workspaceFolder) {
        vscode.window.showWarningMessage(
          "Chronos: Open a workspace folder first (this becomes your workspace directory)."
        );
        return;
      }

      const workspaceEnv = readEnvFile(join(workspaceFolder, ".chronos", ".env"));

      // Open the page viewer panel immediately (shows empty state until
      // the user runs /select-source in the pi TUI).
      pageViewer.ensurePanel();

      // Launch pi in the workspace directory. Source selection happens
      // at runtime via the /select-source command inside the pi TUI.
      const terminal = vscode.window.createTerminal({
        name: "Chronos",
        cwd: workspaceFolder,
        env: { CHRONOS_IPC_SOCKET: ipcServer.socketPath, ...workspaceEnv },
      });
      terminal.sendText("pi");
      terminal.show(true);
    }),

    vscode.commands.registerCommand("chronos.showPage", async () => {
      if (!workspaceFolder) return;

      const sourcesDir = join(workspaceFolder, "sources");
      const sources = existsSync(sourcesDir) ? discoverSources(sourcesDir) : [];
      if (sources.length === 0) {
        vscode.window.showWarningMessage("Chronos: No sources found.");
        return;
      }

      const picked = await vscode.window.showQuickPick(
        sources.map((s) => ({ label: s.name, detail: s.path, source: s })),
        { placeHolder: "Select a source" }
      );
      if (!picked) return;

      const pageIdStr = await vscode.window.showInputBox({
        prompt: "Page ID (number)",
        value: "1",
      });
      if (!pageIdStr) return;

      const pageId = parseInt(pageIdStr, 10);
      if (isNaN(pageId)) return;

      pageViewer.showPage(picked.source.path, path.basename(picked.source.path), pageId, null, countPages(picked.source.path));
    }),

    vscode.commands.registerCommand("chronos.importSources", async () => {
      if (!workspaceFolder) {
        vscode.window.showWarningMessage("Chronos: Open a workspace folder first.");
        return;
      }

      const sourcesDir = join(workspaceFolder, "sources");
      if (!existsSync(sourcesDir)) {
        vscode.window.showWarningMessage(
          "Chronos: No sources/ directory. Run \"Chronos: Init Workspace\" first."
        );
        return;
      }

      const result = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Import Sources from Folder",
        title: "Select a folder containing PDFs, images, or text files",
      });
      if (!result || result.length === 0) return;

      const folderPath = result[0].fsPath;
      const importResult = await importSources(folderPath, sourcesDir);

      const parts: string[] = [];
      if (importResult.imported > 0) parts.push(`${importResult.imported} imported`);
      if (importResult.skipped.length > 0) parts.push(`${importResult.skipped.length} skipped (already exist)`);
      if (importResult.errors.length > 0) parts.push(`${importResult.errors.length} errors`);

      const summary = parts.join(", ");
      if (importResult.errors.length > 0) {
        vscode.window.showWarningMessage(`Chronos Import: ${summary}. Errors: ${importResult.errors.join("; ")}`);
      } else {
        vscode.window.showInformationMessage(`Chronos Import: ${summary}.`);
      }
    }),

    vscode.commands.registerCommand("chronos.init", async () => {
      if (!workspaceFolder) {
        vscode.window.showWarningMessage(
          "Chronos: Open a folder first, then run Init to set it up as a Chronos workspace."
        );
        return;
      }

      const success = await initWorkspace(workspaceFolder);
      if (success) {
        vscode.window.showInformationMessage(
          "Chronos workspace initialized. Add source directories to sources/ to get started."
        );
      }
    }),

    vscode.commands.registerCommand("chronos.windowSetup", async () => {
      // 1. Close all editor tabs
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      // 2. Move entire panel to the right sidebar
      await vscode.commands.executeCommand("workbench.action.movePanelToSecondarySideBar");
      // 3. Move chat back to the bottom panel
      for (const cmd of [
        "workbench.action.chat.moveToPanel",
        "workbench.action.chat.open",
      ]) {
        try { await vscode.commands.executeCommand(cmd); } catch { /* skip if unavailable */ }
      }
    }),

    // Clickable [view p.N] links in the terminal → open page in chronos-viewer
    vscode.window.registerTerminalLinkProvider({
      provideTerminalLinks(context): vscode.TerminalLink[] {
        const matches: vscode.TerminalLink[] = [];
        const re = /\[view p\.(\d+)\]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(context.line)) !== null) {
          const link = new vscode.TerminalLink(m.index, m[0].length, m[1]);
          matches.push(link);
        }
        return matches;
      },
      handleTerminalLink(link: vscode.TerminalLink): void {
        const pageId = parseInt(link.tooltip!, 10);
        if (isNaN(pageId)) return;
        const srcDir = pageViewer.sourceDir;
        const srcName = pageViewer.sourceName;
        if (srcDir && srcName) {
          pageViewer.showPage(srcDir, srcName, pageId, null, pageViewer.totalPages);
        }
      },
    }),

    { dispose: () => ipcServer.dispose() }
  );
}

export function deactivate(): void {
  // Cleanup handled by subscriptions
}
