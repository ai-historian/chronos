import * as vscode from "vscode";
import * as path from "path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

type Bbox = { x: number; y: number; w: number; h: number };

export class PageViewerProvider {
  private panel: vscode.WebviewPanel | undefined;
  private currentSourceDir: string | undefined;
  private currentSourceName: string | undefined;
  private currentPageId = 1;
  private firstPage = 1;
  private lastPage = 1;
  private workspaceRoot: string | undefined;

  constructor(workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot;
  }

  get sourceDir(): string | undefined { return this.currentSourceDir; }
  get sourceName(): string | undefined { return this.currentSourceName; }
  get totalPages(): number { return this.lastPage; }

  /** Create the viewer panel in empty state (shows "Waiting for agent..."). */
  ensurePanel(): void {
    if (this.panel) return;
    const resourceRoot = this.workspaceRoot ?? process.cwd();
    this.panel = vscode.window.createWebviewPanel(
      "chronos.pageViewer",
      "Chronos Viewer",
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(resourceRoot)],
      },
    );
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.setupMessageHandling();
  }

  showPage(sourceDir: string, sourceName: string, pageId: number, bbox: Bbox | null, totalPages?: number): void {
    this.currentSourceDir = sourceDir;
    this.currentSourceName = sourceName || this.currentSourceName;
    this.currentPageId = pageId;

    if (totalPages && totalPages > 0) {
      this.firstPage = 1;
      this.lastPage = totalPages;
    }

    if (!this.panel) {
      // Use workspace root if available, otherwise fall back to source parent
      const resourceRoot = this.workspaceRoot ?? path.dirname(sourceDir);
      this.panel = vscode.window.createWebviewPanel(
        "chronos.pageViewer",
        `${this.currentSourceName ?? "Chronos"} — Page ${pageId}`,
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(resourceRoot)],
        }
      );
      this.panel.webview.html = this.getHtml(this.panel.webview);
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
      this.setupMessageHandling();
    }

    const pageBase = `page_${String(pageId).padStart(4, "0")}`;
    let pagePath = path.join(sourceDir, "png", pageBase + ".png");
    for (const ext of [".png", ".jpg", ".jpeg"]) {
      const candidate = path.join(sourceDir, "png", pageBase + ext);
      if (existsSync(candidate)) {
        pagePath = candidate;
        break;
      }
    }
    const imageUri = this.panel.webview.asWebviewUri(
      vscode.Uri.file(pagePath)
    );

    this.panel.webview.postMessage({
      type: "show_page",
      imageUri: imageUri.toString(),
      pageId,
      sourceName: this.currentSourceName,
      firstPage: this.firstPage,
      lastPage: this.lastPage,
      bbox,
    });

    this.panel.title = `chronos-viewer - p.${pageId}${this.currentSourceName ? ` - ${this.currentSourceName}` : ""}`;
  }

  showText(filePath: string, content: string, highlight: string | null, sourceName: string): void {
    this.currentSourceName = sourceName;

    if (!this.panel) {
      const resourceRoot = this.workspaceRoot ?? process.cwd();
      this.panel = vscode.window.createWebviewPanel(
        "chronos.pageViewer",
        `${sourceName} — Text`,
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(resourceRoot)],
        }
      );
      this.panel.webview.html = this.getHtml(this.panel.webview);
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
      this.setupMessageHandling();
    }

    this.panel.webview.postMessage({
      type: "show_text",
      filePath,
      content,
      highlight,
      sourceName,
    });

    const fileName = path.basename(filePath);
    this.panel.title = `chronos-viewer - ${fileName}${sourceName ? ` - ${sourceName}` : ""}`;
  }

  setPageRange(firstPage: number, lastPage: number): void {
    this.firstPage = firstPage;
    this.lastPage = lastPage;
    this.panel?.webview.postMessage({
      type: "update_range",
      firstPage,
      lastPage,
    });
  }

  private setupMessageHandling(): void {
    this.panel!.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "navigate" && this.currentSourceDir && this.currentSourceName) {
        this.showPage(this.currentSourceDir, this.currentSourceName, msg.pageId, null);
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("hex");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: 13px;
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
      background: var(--vscode-editorWidget-background);
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      flex-shrink: 0;
    }
    .toolbar button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 3px 8px;
      cursor: pointer;
      border-radius: 2px;
      font-size: 13px;
    }
    .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .toolbar button:disabled { opacity: 0.4; cursor: default; }
    .toolbar input {
      width: 60px;
      text-align: center;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      padding: 2px 4px;
      border-radius: 2px;
      font-size: 13px;
    }
    .toolbar .separator { width: 1px; height: 20px; background: var(--vscode-editorWidget-border); margin: 0 4px; }
    .toolbar .page-info { white-space: nowrap; }
    .viewer-container {
      flex: 1;
      overflow: auto;
      position: relative;
    }
    .image-wrapper {
      position: relative;
      display: inline-block;
    }
    .image-wrapper img {
      display: block;
      max-width: none;
      height: auto;
    }
    .bbox-overlay {
      position: absolute;
      border: 2px solid #ff6600;
      background: rgba(255, 102, 0, 0.15);
      pointer-events: none;
      display: none;
    }
    .text-container {
      flex: 1;
      overflow: auto;
      padding: 16px 20px;
      display: none;
    }
    .text-container pre {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
      margin: 0;
      color: var(--vscode-editor-foreground);
    }
    .text-container mark {
      background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
      color: inherit;
      border-radius: 2px;
      padding: 1px 0;
    }
    .text-container .file-label {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      margin-bottom: 8px;
    }
    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="prev10" title="Back 10 pages">&#x25C2;&#x25C2;</button>
    <button id="prev1" title="Previous page">&#x25C2;</button>
    <input id="pageInput" type="number" min="1" value="1">
    <span class="page-info">/ <span id="totalPages">1</span></span>
    <button id="next1" title="Next page">&#x25B8;</button>
    <button id="next10" title="Forward 10 pages">&#x25B8;&#x25B8;</button>
    <div class="separator"></div>
    <button id="zoomOut" title="Zoom out">-</button>
    <span id="zoomLevel">100%</span>
    <button id="zoomIn" title="Zoom in">+</button>
    <button id="zoomFit" title="Fit to width">Fit</button>
    <div class="separator"></div>
    <span id="sourceLabel" class="page-info"></span>
  </div>
  <div class="viewer-container" id="viewerContainer">
    <div class="empty-state" id="emptyState">Waiting for agent to show a page...</div>
    <div class="image-wrapper" id="imageWrapper" style="display:none;">
      <img id="pageImage" alt="Page">
      <div class="bbox-overlay" id="bboxOverlay"></div>
    </div>
    <canvas id="cropCanvas" style="display:none;"></canvas>
  </div>
  <div class="text-container" id="textContainer">
    <div class="file-label" id="textFileLabel"></div>
    <pre id="textContent"></pre>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const pageImage = document.getElementById("pageImage");
    const imageWrapper = document.getElementById("imageWrapper");
    const viewerContainer = document.getElementById("viewerContainer");
    const emptyState = document.getElementById("emptyState");
    const bboxOverlay = document.getElementById("bboxOverlay");
    const pageInput = document.getElementById("pageInput");
    const totalPagesEl = document.getElementById("totalPages");
    const zoomLevelEl = document.getElementById("zoomLevel");
    const sourceLabel = document.getElementById("sourceLabel");
    const textContainer = document.getElementById("textContainer");
    const textContent = document.getElementById("textContent");
    const textFileLabel = document.getElementById("textFileLabel");

    const cropCanvas = document.getElementById("cropCanvas");
    const cropCtx = cropCanvas.getContext("2d");

    let currentPageId = 1;
    let firstPage = 1;
    let lastPage = 1;
    let zoom = 100;
    let currentBbox = null;
    let showingCrop = false;

    function navigate(pageId) {
      pageId = Math.max(firstPage, Math.min(lastPage, pageId));
      vscodeApi.postMessage({ type: "navigate", pageId });
    }

    function updateZoom() {
      const displayEl = showingCrop ? cropCanvas : pageImage;
      const natW = showingCrop ? cropCanvas.width : pageImage.naturalWidth;
      if (natW > 0) {
        displayEl.style.width = (natW * zoom / 100) + "px";
        displayEl.style.height = "auto";
      }
      zoomLevelEl.textContent = zoom + "%";
    }

    function fitToWidth() {
      const displayEl = showingCrop ? cropCanvas : pageImage;
      const natW = showingCrop ? cropCanvas.width : pageImage.naturalWidth;
      if (natW > 0) {
        zoom = Math.round((viewerContainer.clientWidth / natW) * 100);
        zoom = Math.max(25, Math.min(400, zoom));
      }
      updateZoom();
    }

    function updateNav() {
      pageInput.value = currentPageId;
      document.getElementById("prev1").disabled = currentPageId <= firstPage;
      document.getElementById("prev10").disabled = currentPageId <= firstPage;
      document.getElementById("next1").disabled = currentPageId >= lastPage;
      document.getElementById("next10").disabled = currentPageId >= lastPage;
    }

    function showCrop(bbox) {
      if (!bbox) {
        currentBbox = null;
        showingCrop = false;
        cropCanvas.style.display = "none";
        pageImage.style.display = "block";
        bboxOverlay.style.display = "none";
        return;
      }
      currentBbox = bbox;
      if (pageImage.naturalWidth > 0 && pageImage.complete) {
        applyCrop(bbox);
      }
    }

    function applyCrop(bbox) {
      const natW = pageImage.naturalWidth;
      const natH = pageImage.naturalHeight;
      const sx = bbox.x * natW;
      const sy = bbox.y * natH;
      const sw = bbox.w * natW;
      const sh = bbox.h * natH;
      cropCanvas.width = sw;
      cropCanvas.height = sh;
      cropCtx.drawImage(pageImage, sx, sy, sw, sh, 0, 0, sw, sh);

      showingCrop = true;
      pageImage.style.display = "none";
      bboxOverlay.style.display = "none";
      cropCanvas.style.display = "block";
      fitToWidth();
    }

    pageImage.onload = function() {
      if (currentBbox) {
        applyCrop(currentBbox);
      } else {
        showingCrop = false;
        cropCanvas.style.display = "none";
        pageImage.style.display = "block";
        fitToWidth();
      }
    };

    // Navigation buttons
    document.getElementById("prev10").onclick = () => navigate(currentPageId - 10);
    document.getElementById("prev1").onclick = () => navigate(currentPageId - 1);
    document.getElementById("next1").onclick = () => navigate(currentPageId + 1);
    document.getElementById("next10").onclick = () => navigate(currentPageId + 10);

    pageInput.addEventListener("change", () => {
      const val = parseInt(pageInput.value, 10);
      if (!isNaN(val)) navigate(val);
    });
    pageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const val = parseInt(pageInput.value, 10);
        if (!isNaN(val)) navigate(val);
      }
    });

    // Zoom buttons
    document.getElementById("zoomOut").onclick = () => { zoom = Math.max(25, zoom - 25); updateZoom(); };
    document.getElementById("zoomIn").onclick = () => { zoom = Math.min(400, zoom + 25); updateZoom(); };
    document.getElementById("zoomFit").onclick = () => { fitToWidth(); };

    // Ctrl+scroll to zoom
    viewerContainer.addEventListener("wheel", (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        zoom = Math.max(25, Math.min(400, zoom + (e.deltaY < 0 ? 10 : -10)));
        updateZoom();
      }
    }, { passive: false });

    // Keyboard navigation
    document.addEventListener("keydown", (e) => {
      if (e.target === pageInput) return;
      if (e.key === "ArrowLeft") navigate(currentPageId - (e.shiftKey ? 10 : 1));
      if (e.key === "ArrowRight") navigate(currentPageId + (e.shiftKey ? 10 : 1));
    });

    // Messages from extension
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "show_page") {
        emptyState.style.display = "none";
        imageWrapper.style.display = "block";
        textContainer.style.display = "none";
        viewerContainer.style.display = "block";
        pageImage.src = msg.imageUri;
        currentPageId = msg.pageId;
        firstPage = msg.firstPage;
        lastPage = msg.lastPage;
        totalPagesEl.textContent = lastPage;
        sourceLabel.textContent = msg.sourceName || "";
        showCrop(msg.bbox);
        updateNav();
      } else if (msg.type === "show_text") {
        emptyState.style.display = "none";
        imageWrapper.style.display = "none";
        viewerContainer.style.display = "none";
        textContainer.style.display = "block";
        const fileName = msg.filePath.split(/[/\\\\]/).pop() || msg.filePath;
        textFileLabel.textContent = fileName;
        if (msg.highlight && msg.content.includes(msg.highlight)) {
          const escaped = msg.content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
          const hlEscaped = msg.highlight.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
          textContent.innerHTML = escaped.replaceAll(hlEscaped, "<mark>" + hlEscaped + "<" + "/mark>");
          // Scroll to first highlight
          const firstMark = textContent.querySelector("mark");
          if (firstMark) firstMark.scrollIntoView({ block: "center" });
        } else {
          textContent.textContent = msg.content;
        }
        sourceLabel.textContent = msg.sourceName || "";
      } else if (msg.type === "update_range") {
        firstPage = msg.firstPage;
        lastPage = msg.lastPage;
        totalPagesEl.textContent = msg.lastPage;
        updateNav();
      }
    });
  </script>
</body>
</html>`;
  }
}
