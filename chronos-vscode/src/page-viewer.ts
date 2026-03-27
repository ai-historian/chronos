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
      display: flex;
      justify-content: center;
    }
    .image-wrapper {
      position: relative;
      transform-origin: top center;
    }
    .image-wrapper img {
      display: block;
      max-width: none;
    }
    .bbox-overlay {
      position: absolute;
      border: 2px solid #ff6600;
      background: rgba(255, 102, 0, 0.15);
      pointer-events: none;
      display: none;
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

    let currentPageId = 1;
    let firstPage = 1;
    let lastPage = 1;
    let zoom = 100;
    let currentBbox = null;

    function navigate(pageId) {
      pageId = Math.max(firstPage, Math.min(lastPage, pageId));
      vscodeApi.postMessage({ type: "navigate", pageId });
    }

    function updateZoom() {
      imageWrapper.style.transform = "scale(" + (zoom / 100) + ")";
      zoomLevelEl.textContent = zoom + "%";
    }

    function updateNav() {
      pageInput.value = currentPageId;
      document.getElementById("prev1").disabled = currentPageId <= firstPage;
      document.getElementById("prev10").disabled = currentPageId <= firstPage;
      document.getElementById("next1").disabled = currentPageId >= lastPage;
      document.getElementById("next10").disabled = currentPageId >= lastPage;
    }

    function showBbox(bbox) {
      if (!bbox) {
        bboxOverlay.style.display = "none";
        currentBbox = null;
        return;
      }
      currentBbox = bbox;
      // Position after image loads
      const img = pageImage;
      if (img.naturalWidth > 0) {
        applyBbox(img.naturalWidth, img.naturalHeight, bbox);
      }
    }

    function applyBbox(natW, natH, bbox) {
      bboxOverlay.style.left = (bbox.x * natW) + "px";
      bboxOverlay.style.top = (bbox.y * natH) + "px";
      bboxOverlay.style.width = (bbox.w * natW) + "px";
      bboxOverlay.style.height = (bbox.h * natH) + "px";
      bboxOverlay.style.display = "block";
    }

    pageImage.onload = function() {
      if (currentBbox) {
        applyBbox(pageImage.naturalWidth, pageImage.naturalHeight, currentBbox);
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
    document.getElementById("zoomFit").onclick = () => {
      if (pageImage.naturalWidth > 0) {
        zoom = Math.round((viewerContainer.clientWidth / pageImage.naturalWidth) * 100);
        zoom = Math.max(25, Math.min(400, zoom));
        updateZoom();
      }
    };

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
        pageImage.src = msg.imageUri;
        currentPageId = msg.pageId;
        firstPage = msg.firstPage;
        lastPage = msg.lastPage;
        totalPagesEl.textContent = lastPage;
        sourceLabel.textContent = msg.sourceName || "";
        showBbox(msg.bbox);
        updateNav();
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
