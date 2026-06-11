import * as vscode from "vscode";
import * as path from "path";
import { readdirSync, statSync, existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { Worker } from "node:worker_threads";
import { execSync, execFileSync, spawn } from "node:child_process";
// mupdf is ESM-only — loaded via dynamic import() where needed
import { HttpServer } from "./http-server";
import { PageViewerProvider } from "./page-viewer";

const PI_NPM_PACKAGE = "@mariozechner/pi-coding-agent";
const CHRONOS_PI_PACKAGE = "https://github.com/ai-historian/history-agent";

function hasPi(): boolean {
  try {
    execSync("pi --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function ensureBootstrap(context: vscode.ExtensionContext): Promise<boolean> {
  if (!hasPi()) {
    const choice = await vscode.window.showWarningMessage(
      "Chronos requires pi (an AI agent CLI) and the Chronos pi-package. Install them now in a terminal?",
      { modal: true },
      "Install",
    );
    if (choice !== "Install") return false;
    const terminal = vscode.window.createTerminal({ name: "Chronos setup" });
    terminal.sendText(
      `npm install -g ${PI_NPM_PACKAGE} && pi install ${CHRONOS_PI_PACKAGE} && echo "" && echo "Chronos setup complete. Re-run the Chronos command from the Command Palette."`,
    );
    terminal.show(true);
    vscode.window.showInformationMessage(
      "Chronos setup started in the terminal. Re-run the Chronos command once it completes.",
    );
    return false;
  }
  const key = "chronos.piPackageInstalled";
  if (!context.globalState.get(key)) {
    const choice = await vscode.window.showInformationMessage(
      "Install the Chronos pi-package? (one-time registration with pi)",
      { modal: true },
      "Install",
      "Already installed",
    );
    if (choice === "Install") {
      const terminal = vscode.window.createTerminal({ name: "Chronos setup" });
      terminal.sendText(
        `pi install ${CHRONOS_PI_PACKAGE} && echo "" && echo "Done. Re-run the Chronos command."`,
      );
      terminal.show(true);
      await context.globalState.update(key, true);
      return false;
    }
    if (choice === "Already installed") {
      await context.globalState.update(key, true);
    } else {
      return false;
    }
  }
  return true;
}

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

// The bundled mupdf package is a WASM build: Document.openDocument(filePath) reads the
// whole file into a Buffer via readFileSync, which Node caps at 2 GiB (ERR_FS_FILE_TOO_LARGE).
const MAX_WASM_PDF_BYTES = 2 ** 31;

function hasCommand(cmd: string): boolean {
  try {
    execSync(process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Render with the native mutool CLI — same engine as the WASM mupdf package (identical
// output), but with true memory-mapped I/O, so there is no file size limit.
async function convertPdfNative(
  filePath: string,
  pngDir: string,
  sourceName: string,
  progress: (msg: string) => void,
): Promise<void> {
  const info = execFileSync("mutool", ["info", filePath], { encoding: "utf8" });
  const match = info.match(/^Pages:\s+(\d+)/m);
  if (!match) throw new Error("mutool info did not report a page count");
  const totalPages = parseInt(match[1], 10);

  const POOL_SIZE = 4;
  const BATCH_SIZE = 50;
  // mutool page ranges are 1-indexed inclusive; %04d in the output pattern expands to
  // the actual page number, so concurrent batches never collide.
  const batches: { start: number; end: number }[] = [];
  for (let i = 1; i <= totalPages; i += BATCH_SIZE) {
    batches.push({ start: i, end: Math.min(i + BATCH_SIZE - 1, totalPages) });
  }

  progress(`Converting PDF: ${sourceName} (${totalPages} pages, experimental native mutool fallback)...`);

  let completed = 0;
  let batchIdx = 0;
  const runNext = (): Promise<void> => {
    const idx = batchIdx++;
    if (idx >= batches.length) return Promise.resolve();
    const { start, end } = batches[idx];
    return new Promise<void>((resolve, reject) => {
      const proc = spawn("mutool", [
        "draw", "-r", "200",
        "-o", join(pngDir, "page_%04d.png"),
        filePath, `${start}-${end}`,
      ]);
      let lastErrLine = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        // mutool reports "page <file> <num>" per rendered page on stderr
        for (const line of chunk.toString().split("\n")) {
          if (line.startsWith("page ")) {
            completed++;
            progress(`Converting PDF: ${sourceName} (${completed}/${totalPages} pages)...`);
          } else if (line.trim()) {
            lastErrLine = line.trim();
          }
        }
      });
      proc.on("error", reject);
      proc.on("exit", (code) => {
        if (code !== 0) {
          reject(new Error(lastErrLine || `mutool exited with code ${code}`));
        } else {
          resolve();
        }
      });
    }).then(() => runNext());
  };

  await Promise.all(Array.from({ length: Math.min(POOL_SIZE, batches.length) }, () => runNext()));
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
      // Files >= 2 GiB can't be opened by the WASM mupdf build — use native mutool instead
      if (statSync(filePath).size >= MAX_WASM_PDF_BYTES) {
        if (!hasCommand("mutool")) {
          throw new Error(
            `file exceeds the 2 GiB limit of the bundled renderer. Files this large are only supported via an experimental workaround that renders with the native "mutool" CLI, which was not found — install it (e.g. sudo apt install mupdf-tools) and retry`,
          );
        }
        await convertPdfNative(filePath, pngDir, sourceName, progress);
        return { ok: true };
      }

      const mupdf = await import("mupdf");
      const doc = mupdf.Document.openDocument(filePath, "application/pdf");
      const totalPages = doc.countPages();

      if (totalPages <= 1) {
        // Render directly — no worker overhead
        const dpi = 200;
        const scale = dpi / 72;
        for (let i = 0; i < totalPages; i++) {
          const page = doc.loadPage(i);
          const pixmap = page.toPixmap(
            mupdf.Matrix.scale(scale, scale),
            mupdf.ColorSpace.DeviceRGB,
            false,
          );
          const pageNum = String(i + 1).padStart(4, "0");
          writeFileSync(join(pngDir, `page_${pageNum}.png`), pixmap.asPNG());
        }
      } else {
        // Worker pool: run max POOL_SIZE workers concurrently, each renders a
        // batch of pages. Workers load the original PDF but only render their
        // assigned range, then exit to free memory before the next batch starts.
        const POOL_SIZE = 4;
        const BATCH_SIZE = 50;
        const workerScript = join(__dirname, "pdf-worker.js");
        let completed = 0;

        const batches: { start: number; end: number }[] = [];
        for (let i = 0; i < totalPages; i += BATCH_SIZE) {
          batches.push({ start: i, end: Math.min(i + BATCH_SIZE, totalPages) });
        }

        progress(`Converting PDF: ${sourceName} (${totalPages} pages, pool of ${POOL_SIZE})...`);

        // Process batches with limited concurrency
        let batchIdx = 0;
        const runNext = (): Promise<void> => {
          const idx = batchIdx++;
          if (idx >= batches.length) return Promise.resolve();
          const { start, end } = batches[idx];
          return new Promise<void>((resolve, reject) => {
            const w = new Worker(workerScript, {
              workerData: { filePath, pngDir, startPage: start, endPage: end, pageOffset: 0, dpi: 200 },
            });
            let workerError = "";
            w.on("message", (msg: { type: string; page?: number; message?: string }) => {
              if (msg.type === "progress") {
                completed++;
                progress(`Converting PDF: ${sourceName} (${completed}/${totalPages} pages)...`);
              } else if (msg.type === "error") {
                workerError = msg.message ?? "unknown error";
              }
            });
            w.on("error", reject);
            w.on("exit", (code) => {
              if (code !== 0) {
                reject(new Error(workerError || `Worker exited with code ${code}`));
              } else {
                resolve();
              }
            });
          }).then(() => runNext());
        };

        const lanes = Array.from({ length: Math.min(POOL_SIZE, batches.length) }, () => runNext());
        await Promise.all(lanes);
      }

      return { ok: true };
    } catch (err) {
      // Remove the partial source dir so a retry isn't rejected as "already exists"
      rmSync(sourceDir, { recursive: true, force: true });
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

  const httpServer = new HttpServer();
  const pageViewer = new PageViewerProvider(workspaceFolder);

  httpServer.onMessage((msg) => {
    console.log(`[chronos-ext] Handling message: ${msg.type}`);
    try {
      switch (msg.type) {
        case "show_page":
          console.log(`[chronos-ext] showPage: dir=${msg.sourceDir}, page=${msg.pageId}`);
          pageViewer.showPage(msg.sourceDir, msg.sourceName, msg.pageId, msg.bbox, msg.totalPages);
          break;
        case "page_list":
          pageViewer.setPageRange(msg.firstPage, msg.lastPage);
          break;
        case "show_text":
          pageViewer.showText(msg.filePath, msg.content, msg.highlight, msg.sourceName);
          break;
      }
    } catch (err) {
      console.error(`[chronos-ext] Error handling ${msg.type}:`, err);
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

      if (!(await ensureBootstrap(context))) return;

      const workspaceEnv = readEnvFile(join(workspaceFolder, ".chronos", ".env"));

      // Open the page viewer panel immediately (shows empty state until
      // the user runs /select-source in the pi TUI).
      pageViewer.ensurePanel();

      // Wait for the HTTP server to be ready so the port is assigned
      await httpServer.ready;

      // Launch pi in the workspace directory. Source selection happens
      // at runtime via the /select-source command inside the pi TUI.
      const terminal = vscode.window.createTerminal({
        name: "Chronos",
        cwd: workspaceFolder,
        env: { CHRONOS_HTTP_PORT: String(httpServer.port), ...workspaceEnv },
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

      if (!(await ensureBootstrap(context))) return;

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

    // Clickable [view p.N], [view p.N#sel=x,y,w,h], and [view p.N@sourcePath] links in the terminal.
    // No space inside the brackets so the TUI host can't word-wrap mid-link.
    vscode.window.registerTerminalLinkProvider({
      provideTerminalLinks(context): vscode.TerminalLink[] {
        const matches: vscode.TerminalLink[] = [];
        const re = /\[view p\.(\d+)(?:#sel=([\d.]+),([\d.]+),([\d.]+),([\d.]+))?(?:@([^\]]+))?\]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(context.line)) !== null) {
          let data = m[1];
          if (m[2]) data += `|bbox:${m[2]},${m[3]},${m[4]},${m[5]}`;
          if (m[6]) data += `@${m[6]}`;
          const link = new vscode.TerminalLink(m.index, m[0].length, data);
          matches.push(link);
        }
        return matches;
      },
      handleTerminalLink(link: vscode.TerminalLink): void {
        let data = link.tooltip!;
        let pageId: number;
        let srcDir: string | undefined;
        let srcName: string | undefined;
        let bbox: { x: number; y: number; w: number; h: number } | null = null;

        // Extract bbox if present
        const bboxMatch = data.match(/\|bbox:([\d.]+),([\d.]+),([\d.]+),([\d.]+)/);
        if (bboxMatch) {
          bbox = {
            x: parseFloat(bboxMatch[1]),
            y: parseFloat(bboxMatch[2]),
            w: parseFloat(bboxMatch[3]),
            h: parseFloat(bboxMatch[4]),
          };
          data = data.replace(bboxMatch[0], "");
        }

        const atIdx = data.indexOf("@");
        if (atIdx !== -1) {
          pageId = parseInt(data.slice(0, atIdx), 10);
          srcDir = data.slice(atIdx + 1);
          srcName = path.basename(srcDir);
        } else {
          pageId = parseInt(data, 10);
          srcDir = pageViewer.sourceDir;
          srcName = pageViewer.sourceName;
        }

        if (isNaN(pageId) || !srcDir || !srcName) return;
        pageViewer.showPage(srcDir, srcName, pageId, bbox, pageViewer.totalPages);
      },
    }),

    { dispose: () => httpServer.dispose() }
  );
}

export function deactivate(): void {
  // Cleanup handled by subscriptions
}
