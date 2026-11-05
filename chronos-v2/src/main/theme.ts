// Light/dark palettes for the renderer. The copied webview CSS consumes
// VS Code variable names (--vscode-*), so we define those here.

export type ThemeName = "light" | "dark";

const FONTS: Record<string, string> = {
  "--vscode-font-family": 'system-ui, -apple-system, "Segoe UI", sans-serif',
  "--vscode-font-size": "13px",
  "--vscode-editor-font-family": "ui-monospace, Menlo, Consolas, monospace",
  "--vscode-editor-font-size": "13px",
};

export const THEMES: Record<ThemeName, Record<string, string>> = {
  // Modelled on VS Code Dark Modern
  dark: {
    ...FONTS,
    "--vscode-editor-background": "#1f1f1f",
    "--vscode-editor-foreground": "#cccccc",
    "--vscode-editorWidget-background": "#202020",
    "--vscode-editorWidget-border": "#454545",
    "--vscode-editorWarning-foreground": "#cca700",
    "--vscode-errorForeground": "#f85149",
    "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-focusBorder": "#0078d4",
    "--vscode-button-background": "#0078d4",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-hoverBackground": "#026ec1",
    "--vscode-button-secondaryBackground": "#313131",
    "--vscode-button-secondaryHoverBackground": "#3c3c3c",
    "--vscode-dropdown-background": "#313131",
    "--vscode-dropdown-foreground": "#cccccc",
    "--vscode-input-background": "#313131",
    "--vscode-input-foreground": "#cccccc",
    "--vscode-input-border": "#3c3c3c",
    "--vscode-textCodeBlock-background": "#2b2b2b",
    "--vscode-textLink-foreground": "#4daafc",
  },
  // Modelled on VS Code Light Modern
  light: {
    ...FONTS,
    "--vscode-editor-background": "#ffffff",
    "--vscode-editor-foreground": "#3b3b3b",
    "--vscode-editorWidget-background": "#f8f8f8",
    "--vscode-editorWidget-border": "#c8c8c8",
    "--vscode-editorWarning-foreground": "#bf8803",
    "--vscode-errorForeground": "#f85149",
    "--vscode-descriptionForeground": "#717171",
    "--vscode-focusBorder": "#005fb8",
    "--vscode-button-background": "#005fb8",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-hoverBackground": "#0258a8",
    "--vscode-button-secondaryBackground": "#e5e5e5",
    "--vscode-button-secondaryHoverBackground": "#cccccc",
    "--vscode-dropdown-background": "#ffffff",
    "--vscode-dropdown-foreground": "#3b3b3b",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#3b3b3b",
    "--vscode-input-border": "#cecece",
    "--vscode-textCodeBlock-background": "#f0f0f0",
    "--vscode-textLink-foreground": "#005fb8",
  },
};

export function themeCss(name: ThemeName): string {
  const body = Object.entries(THEMES[name])
    .map(([k, v]) => `${k}:${v};`)
    .join("");
  return `:root{${body}}`;
}

export function resolveTheme(pref: "system" | ThemeName, nativeDark: boolean): ThemeName {
  if (pref === "system") return nativeDark ? "dark" : "light";
  return pref;
}
