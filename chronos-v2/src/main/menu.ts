import type { MenuItemConstructorOptions } from "electron";
import type { ModelInfo, ThinkingLevel } from "./rpc/rpc-types";

export interface MenuActions {
  newWorkspace(): void;
  openWorkspace(): void;
  openRecent(path: string): void;
  importSources(): void;
  closeWorkspace(): void;
  newSession(): void;
  resumeSession(): void;
  restartAgent(): void;
  showPage(): void;
  login(): void;
  setModel(provider: string, id: string): void;
  setThinking(level: ThinkingLevel): void;
  toggleYolo(): void;
  toggleTree(): void;
  toggleChat(): void;
  setTheme(t: "system" | "light" | "dark"): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  openDocs(): void;
  openDiscord(): void;
  reportIssue(): void;
  showLogs(): void;
  about(): void;
}

export interface MenuState {
  models: ModelInfo[];
  currentModel?: string; // "provider/id"
  thinking: ThinkingLevel;
  yolo: boolean;
  theme: "system" | "light" | "dark";
  hasWorkspace: boolean;
  recent: { path: string }[];
}

const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const THEMES: { value: MenuState["theme"]; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Pure menu template; main.ts turns it into the real application menu. */
export function buildMenu(
  a: MenuActions,
  s: MenuState,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const ws = s.hasWorkspace;
  const modelItems: MenuItemConstructorOptions[] = s.models.length
    ? s.models.map((m) => {
        const id = `${m.provider}/${m.id}`;
        return { label: id, type: "radio", checked: id === s.currentModel, click: () => a.setModel(m.provider, m.id) };
      })
    : [{ label: "No models — connect a provider", enabled: false }];
  const recentItems: MenuItemConstructorOptions[] = s.recent.length
    ? s.recent.map((r) => ({ label: r.path, click: () => a.openRecent(r.path) }))
    : [{ label: "No recent workspaces", enabled: false }];

  const menu: MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        { label: "New workspace…", accelerator: "CmdOrCtrl+Shift+N", click: () => a.newWorkspace() },
        { label: "Open workspace…", accelerator: "CmdOrCtrl+O", click: () => a.openWorkspace() },
        { label: "Open recent", submenu: recentItems },
        { type: "separator" },
        { label: "Import sources…", enabled: ws, click: () => a.importSources() },
        { label: "Close workspace", accelerator: "CmdOrCtrl+Shift+W", enabled: ws, click: () => a.closeWorkspace() },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Session",
      enabled: ws,
      submenu: [
        { label: "New session", accelerator: "CmdOrCtrl+N", enabled: ws, click: () => a.newSession() },
        { label: "Resume…", enabled: ws, click: () => a.resumeSession() },
        { label: "Restart agent", accelerator: "CmdOrCtrl+Shift+R", enabled: ws, click: () => a.restartAgent() },
        { label: "Show page…", enabled: ws, click: () => a.showPage() },
      ],
    },
    {
      label: "Agent",
      enabled: ws,
      submenu: [
        { label: "Connect AI provider", enabled: ws, click: () => a.login() },
        { label: "Model", enabled: ws, submenu: modelItems },
        {
          label: "Thinking level",
          enabled: ws,
          submenu: THINKING.map((l) => ({ label: l, type: "radio", checked: l === s.thinking, click: () => a.setThinking(l) })),
        },
        { label: "YOLO mode", type: "checkbox", checked: s.yolo, enabled: ws, click: () => a.toggleYolo() },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Toggle file tree", accelerator: "CmdOrCtrl+B", enabled: ws, click: () => a.toggleTree() },
        { label: "Toggle chat", accelerator: "CmdOrCtrl+J", enabled: ws, click: () => a.toggleChat() },
        { type: "separator" },
        {
          label: "Theme",
          submenu: THEMES.map((t) => ({ label: t.label, type: "radio", checked: t.value === s.theme, click: () => a.setTheme(t.value) })),
        },
        { type: "separator" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "Documentation", click: () => a.openDocs() },
        { label: "Discord", click: () => a.openDiscord() },
        { label: "Report issue", click: () => a.reportIssue() },
        { type: "separator" },
        { label: "Show logs", click: () => a.showLogs() },
        { label: "About", click: () => a.about() },
      ],
    },
  ];
  return platform === "darwin" ? [{ role: "appMenu" }, ...menu] : menu;
}
