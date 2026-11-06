# Chronos v2 — standalone desktop app (design)

Date: 2026-11-05
Status: draft, awaiting approval
Lives in: `chronos-v2/` (new top-level folder in this repo)

## 1. Intent

Chronos's biggest adoption problem is installation. Today a historian must
install VS Code, install Node, install the Chronos extension, and let the
extension bootstrap `npm install -g pi` and `pi install <repo>` through a
terminal task. Every one of those steps fails for some users (minimal GUI
PATH, Windows shell quirks, npm permissions, macOS node_modules
permissions — see the `fix/*` branches).

Chronos v2 is a standalone desktop application. The user installs **one
thing** — a `.deb`/AppImage, a `.dmg`, or an `.exe` — and gets a window
with the page viewer, the chat, and a workspace file tree. Nothing is
downloaded or installed at first run; `pi`, the Chronos agent, the PDF
renderer and the image library are all inside the installer.

The VS Code extension (`chronos-vscode/`) **stays** and keeps being
maintained; v2 is an additional way to run Chronos, not a replacement.
The shared, single-sourced piece is the agent itself (`chronos/`), which
both hosts load.

## 2. Goals

- One installer per platform (Linux, macOS, Windows), zero prerequisites.
- The same working experience as "Chronos: Start Agent Session" today:
  page viewer with bbox highlights, chat with slash commands, tool-call
  approval, model/thinking selection, session list/resume, login.
- A workspace file tree on the left, and an editable tabbed center pane.
- PDF/image import and the `Init Workspace` scaffolding, in-app.
- The agent (`chronos/` pi-package) is loaded from the app bundle, so v2
  never reads or writes the user's `~/.pi` and cannot conflict with a
  separately installed `pi`.

## 3. Non-goals (this round)

- Replacing `pi` as the agent runtime. v2 bundles pi; it does not
  reimplement the agent loop.
- A hosted login / account system. Users bring an Anthropic Pro/Max
  subscription (OAuth) or a provider API key, exactly as today.
- In-app auto-update. First release updates by reinstalling. (Section 9
  leaves the door open.)
- A full IDE. The editor is a plain code editor for the workspace's text
  files, not a VS Code clone.
- Retiring `chronos-vscode/`.
- Code signing / notarization. First release may ship unsigned (see §11).

## 4. Anti-goals (would make this a failure even if it "works")

- Any first-run step that shells out to `npm`, `git`, `pi install`, or
  needs a network connection to become usable.
- Depending on a `pi` the user installed themselves, or mutating
  `~/.pi/agent/settings.json`.
- Diverging the agent: `chronos/` must remain one package usable by both
  hosts. No v2-only tools living outside `chronos/`.
- A webview rewrite. The existing Lit components are reused.

## 5. Constraints

- `pi` requires Node ≥ 22.19. Electron ≥ 35 embeds a Node that satisfies
  this; v2 pins Electron **45.x** (current at time of writing) and
  electron-builder **26.x**.
- `pi` is pinned to **`@earendil-works/pi-coding-agent@0.84.4`** (the
  current release; `chronos/package-lock.json` still builds against
  0.79.10 and must be bumped). Its runtime is `dist/bundle/cli.js` + the
  `dist/bundle/chunks/` it imports + its `node_modules/` (jiti is
  `require`d lazily from there) — ~147 MB; the whole package dir is
  vendored. Its only native modules are clipboard, macOS key-modifier and
  Windows console helpers, all optional in RPC mode.
- **pi 0.84.0 changed the RPC `message_update` event**: it now carries
  only `assistantMessageEvent` deltas and no cumulative `message`. The
  copied chat component relies on that field (`chronos-chat.ts` ~421),
  so v2 must assemble partial assistant messages from the deltas between
  `message_start` and `message_end` (`message_end` stays authoritative).
  `rpc-types.ts`, `mock-pi.mjs` and the canary change accordingly. The
  same fix is owed to `chronos-vscode/` (its users install the latest pi)
  but is out of scope here.
- `chronos/` depends on `sharp` (native, prebuilt per platform via npm
  optional deps) for bbox cropping. It must be bundled per target.
- `mupdf` (WASM) and `pdf-lib` (pure JS) for import — no native code.
- Licensing: the repo is PolyForm Noncommercial; Electron and pi are
  MIT; `sharp` is Apache-2.0 but its `@img/sharp-libvips-*` prebuilds are
  LGPL-3.0-or-later; the npm `mupdf` package is **AGPL-3.0** (Artifex,
  commercially dual-licensed). The `.vsix` already ships both, so the
  installer continues to, and copies every one of those licence texts
  into `resources/licenses/`. Whether AGPL inside a public binary
  installer is acceptable is an open item for Lorenz (§11); if not, the
  PDF renderer is swapped (pdf.js/pdfium) and §7.7 no longer moves
  unchanged.
- `pi` in `--mode rpc` with workspace skills needs the `--skill` flag;
  project-local `.pi/settings.json` is dropped as untrusted in headless
  rpc. v2 passes everything explicitly on the command line and never
  relies on project-settings discovery.

## 6. Decisions already made

Made by Lorenz (recorded as theirs):

- **Electron** is the shell.
- **Layout**: three panes — workspace file tree (left), page viewer /
  files (center), chat (right). Same chat and viewer as today.
- **Center pane is tabbed and editable** (mockup option C): the agent's
  page viewer is a permanent tab; any file opened from the tree becomes a
  tab; CSV/JSON/Markdown/SKILL.md tabs are editable in a plain code
  editor and saved to disk.
- **Both hosts are kept**: `chronos-vscode/` continues; `chronos-v2/` is
  new. The `chronos/` agent is the shared core.
- New folder name: `chronos-v2/`.

Made by Claude (recorded as calls, override freely):

- **Copy, don't share, the host code.** v2 copies the host-neutral files
  from `chronos-vscode/src/` (RPC client, HTTP server, PDF pipeline,
  sessions, sources, OAuth, protocol types) and the whole `webview/`
  into `chronos-v2/`. No shared npm package is extracted. Rationale: the
  v2 webview will grow tabs, a file tree and an editor the VS Code host
  does not need, so the two UIs diverge by design; a shared package would
  be a premature abstraction and would force churn in the released
  extension. The agent (`chronos/`) is the one shared artefact. Revisit
  once v2 is stable.
- **Editor**: CodeMirror 6 (`@codemirror/*`): small, framework-free,
  works inside a Lit component, has CSV/JSON/Markdown language packs.
- **pi isolation**: `PI_CODING_AGENT_DIR` is set to the app's own
  per-user config dir (Electron `app.getPath("userData")/pi-agent`). pi's
  `auth.json`, `settings.json`, model cache etc. live there. The Chronos
  agent is loaded with `--extension <bundle>/chronos/dist/extensions`,
  plus `--skill <workspace>/skills` when that dir exists. `chronos/prompts`
  is **not** registered as prompt templates (the agent reads those `.md`
  files from disk itself; registering them is what creates the
  package-prompt slash-command pollution the panel filters today) and
  `chronos/skills` does not exist in the repo. Isolation from `~/.pi`
  comes from `PI_CODING_AGENT_DIR` alone; no `--no-*` discovery flags.
- **Running pi**: spawn `process.execPath` (the Electron binary) with
  `ELECTRON_RUN_AS_NODE=1` and the bundled `cli.js` as the script. No
  separate Node binary is shipped.
- **Welcome window**: with no workspace open, a small window lists recent
  workspaces, "Open folder…" and "Create workspace…" (which runs the
  init scaffolding on a chosen empty folder). Opening a workspace opens
  the main window. Recent list is stored in userData.
- **Theming**: the app ships a light and a dark theme that define the 24
  `--vscode-*` variables `styles.css` already consumes, following the OS
  `prefers-color-scheme`. The stylesheet is not rewritten.
- **Image delivery to the renderer**: a custom privileged protocol
  `chronos-file://local/<encoded path segments>` registered in the main
  process, restricted to paths under the open workspace (replaces
  `webview.asWebviewUri`). The fixed `local` host is required because
  Chromium parses a `standard` scheme like http and would otherwise take
  the first path segment as a lowercased host.
- **Distribution, first release**: GitHub Releases carrying `.deb` +
  AppImage (x64), `.dmg` per architecture (arm64 and x64 — not universal,
  because the vendored `sharp` prebuilds are single-arch), NSIS `.exe`
  (x64). An apt
  repository and a Homebrew cask tap are a later layer over the same
  files.
- **First release is unsigned.** Signing is wired in electron-builder
  config but gated on env vars (`CSC_LINK`, Apple ID) that only Lorenz
  can provide.

## 7. Architecture

### 7.1 Process model

```
chronos-v2/
  src/main/            Electron main process (Node)
    main.ts            app lifecycle, welcome vs main window, menu
    workspace.ts       open/create/recent workspaces; init scaffolding
    agent-host.ts      owns PiRpcSession + HTTP server; the former ChronosPanel
    pi-launcher.ts     resolves bundled cli.js, builds env/args, spawns pi
    files.ts           file-tree listing + watcher, read/write for editor tabs
    protocol-handler.ts  chronos-file:// scheme
    import/            pdf-worker, pdf-split-worker, pdf-stream, import-status (copied)
    rpc/               pi-rpc-session, rpc-types (copied)
    http-server.ts     (copied)
    sessions.ts, sources.ts, anthropic-oauth.ts (copied)
    theme.ts           light/dark variable tables
  src/preload/
    preload.ts         contextBridge: postMessage/onMessage/getState/setState
  src/renderer/        the webview (copied from chronos-vscode/webview/)
    main.ts            now binds to window.chronos (preload) instead of acquireVsCodeApi
    components/        chronos-app, chronos-chat, page-viewer, data-viewer (copied)
                       + file-tree.ts, center-tabs.ts, code-editor.ts (new)
    styles.css         (copied) + theme variable sheet
  src/shared/
    webview-protocol.ts  (copied, extended — see 7.3)
  resources/           icons, licence texts
  scripts/             bundle-agent.mjs (builds chronos/, copies pi runtime)
  esbuild.mjs          three bundles: main, preload, renderer
  electron-builder.yml
  package.json
```

Main ↔ renderer communication keeps the exact `ExtToWebview` /
`WebviewToExt` envelopes, carried over `ipcRenderer`/`webContents.send`
instead of `webview.postMessage`. The preload exposes
`window.chronos = { postMessage, onMessage, getState, setState }` with the
same shape `main.ts` already expects from `acquireVsCodeApi()`.

Agent ↔ main communication is unchanged: JSONL RPC over stdio (control)
and the HTTP push channel (`CHRONOS_HTTP_PORT`) for viewer events.

### 7.2 Bundling pi and the agent

`scripts/bundle-agent.mjs` (run by `npm run build`):

1. `cd ../chronos && npm ci && npm run build` → `chronos/dist`.
2. Copy `chronos/{dist,prompts,skills,package.json}` and its production
   `node_modules` (dotenv, sharp + the `@img/sharp-<platform>` prebuilds
   for the current target) into `chronos-v2/vendor/chronos/`.
3. Copy `@earendil-works/pi-coding-agent` (the `dist/bundle/cli.js`,
   `package.json`, and its runtime `node_modules`) into
   `chronos-v2/vendor/pi/`. Version pinned in `chronos-v2/package.json`
   (`piVersion`) and asserted by `scripts/rpc-spike.mjs` (copied canary).

`vendor/` is listed in electron-builder `extraResources` (so it never
enters the asar; native `.node` files and worker scripts cannot run from
inside one). Only the two worker bundles and `mupdf` under `out/` are
`asarUnpack`-ed. At runtime `pi-launcher.ts` resolves
`process.resourcesPath/vendor/...`; in development it falls back to
`../chronos` and `node_modules/@earendil-works/pi-coding-agent`.

The agent's `@earendil-works/pi-ai` and `pi-coding-agent` imports are
aliased by pi's extension loader (jiti) to pi's own bundled copies, so
they need no copy under `vendor/chronos/node_modules`. `@sinclair/typebox`
is not aliased, so it moves from `peerDependencies` to `dependencies` in
`chronos/package.json` (harmless for the VS Code path, which already
installs it as a peer). `vendor/chronos/node_modules` is therefore just
`dotenv`, `sharp` (+ `@img/*` prebuilds) and `@sinclair/typebox`, installed
with `npm ci --omit=dev --omit=peer`.

pi env, set by the launcher:

| var | value | why |
|---|---|---|
| `ELECTRON_RUN_AS_NODE` | `1` | Electron binary acts as plain Node |
| `PI_CODING_AGENT_DIR` | `<userData>/pi-agent` | isolate from `~/.pi` |
| `PI_CODING_AGENT_SESSION_DIR` | `<workspace>/sessions` | as today |
| `PI_SKIP_VERSION_CHECK` | `1` | no npm version check at startup |
| `PI_TELEMETRY` | `0` | no install telemetry (`PI_OFFLINE` would also block model-catalog refresh, so it is not used) |
| `CHRONOS_HTTP_PORT` | dynamic | push channel, as today |
| `<PROVIDER>_API_KEY` | from `<workspace>/.chronos/.env` | as today |

### 7.3 Protocol additions

`ExtToWebview` gains:

- `{ type: "tree"; root: string; entries: TreeEntry[] }` — full listing
  (lazy children fetched by `tree/expand`).
- `{ type: "tree/changed"; path: string; kind: "add"|"unlink"|"change" }`
  — from the fs watcher.
- `{ type: "file/content"; path: string; content: string; readOnly: boolean }`
- `{ type: "file/saved"; path: string; ok: boolean; error?: string }`
- `{ type: "theme"; name: "light"|"dark" }`

`WebviewToExt` gains:

- `{ type: "tree/expand"; path: string }`
- `{ type: "file/open"; path: string }` — PNG under `sources/*/png`
  routes to the viewer tab; text files open an editor tab; anything else
  is opened with the OS (`shell.openPath`).
- `{ type: "file/save"; path: string; content: string }`
- `{ type: "file/revealInOs"; path: string }`
- `{ type: "workspace/open" | "workspace/create" | "workspace/import" }`
  (also reachable from the menu)

Everything else in the protocol is unchanged; `viewer/showPage` etc.
keep working so the agent-side `chronos/http/http-client.ts` needs no
changes.

### 7.4 Center pane

`center-tabs.ts` owns a tab strip. Tab kinds:

- `viewer` — exactly one, never closable, hosts `page-viewer` (and the
  existing `data-viewer` / text view behaviours as today). Any
  `viewer/showPage`, `viewer/showText`, `openViewLink` activates it.
- `editor` — `code-editor.ts` wrapping CodeMirror 6; dirty indicator,
  Ctrl/Cmd+S saves via `file/save`, close prompts on unsaved changes.
  Language by extension: csv (plain + column highlight), json, markdown,
  yaml, txt. The data-viewer's table rendering is reused for CSV/JSON
  as a read-only "Table" toggle inside the same tab (call: ship toggle
  if it falls out of reuse easily; otherwise editor only, table later).
- `image` — any PNG/JPG not under a source's `png/` dir (e.g. a crop the
  agent wrote to `data/`), shown with the viewer's zoom/pan but without
  page navigation.

Tabs and the active tab are part of the persisted UI state (`setState`).

### 7.5 File tree

`file-tree.ts`: lazy directory tree rooted at the workspace. Hides
dot-dirs except `.chronos/` is hidden entirely (contains keys). The
currently selected source (from `SourceContext` via the `sources`
message) gets a marker. Right-click menu: Open, Reveal in OS, Copy path,
and on `sources/` "Import sources…". `files.ts` uses `fs.watch` with
recursive on macOS/Windows and a 300 ms debounce; on Linux it watches
expanded directories only.

### 7.6 Menus (replacing VS Code commands)

- **File**: New workspace…, Open workspace…, Open recent ▸, Import
  sources…, Close workspace, Quit.
- **Session**: New session, Resume… (opens the existing session picker
  in the chat pane), Restart agent, Show page… (source + page number
  prompt).
- **Agent**: Connect AI provider (login), Model ▸ (populated from
  `models`), Thinking level ▸, YOLO toggle.
- **View**: Toggle file tree, Toggle chat, Theme (System/Light/Dark),
  Zoom.
- **Help**: Docs, Discord, Report issue, Show logs, About (versions of
  app, pi, agent).

Dialogs: `dialog.showOpenDialog` for folders/files; the login quick-pick
and API-key input become a small in-renderer modal (new component
`provider-dialog.ts`), since Electron has no quick-pick. The OAuth flow
is unchanged (`shell.openExternal` + local callback server).

Progress/notifications: the existing `notify` message renders toasts in
the chat pane; import progress uses a new `{type:"progress"; id; title;
done; total}` message rendered as a bar in the tree pane header.

### 7.7 Import pipeline

`extension.ts`'s `importFile`/`importFiles`/`renderPdfFile`/
`splitLargePdf`/`resumeIncompleteImports` move to `src/main/import/`
unchanged except that `vscode.window.withProgress` becomes the
`progress` message and prompts become dialogs. Workers are separate
esbuild entry points, as now. The crash-resume check runs on workspace
open, as now.

### 7.8 Workspace scaffolding

`initWorkspace()` moves to `workspace.ts` unchanged. The `.pi/settings.json`
skills bridge it writes today is kept for VS Code/pi-TUI users but v2
does not depend on it (it passes `--skill` explicitly).

## 8. Build & release

- `npm run build` → esbuild (main, preload, renderer, two workers) +
  `bundle-agent.mjs`.
- `npm run dev` → esbuild watch + `electron .` against `../chronos` and
  the dev `pi`.
- `npm run dist` → `electron-builder --linux deb AppImage --mac dmg
  --win nsis`. CI (GitHub Actions, matrix over three OSes) runs on tags
  `v2-*` and uploads to the release.
- Typecheck: three tsconfigs (main/preload, renderer, shared); esbuild
  does not typecheck, same rule as the extension.
- Tests carried over: `scripts/rpc-spike.mjs` against the bundled pi;
  a Playwright-for-Electron boot test replacing `test/run-ui-test.mjs`
  (launch app with a fixture workspace, assert the three panes mount and
  pi reaches `state`).

Version: `chronos-v2/package.json` starts at `0.3.0`; the agent version
it bundles is recorded in About.

## 9. Later (explicitly deferred)

- Auto-update via `electron-updater` from GitHub Releases.
- apt repository + Homebrew cask tap.
- Extracting shared host code into a package once v2 stabilises.
- Multiple windows / multiple workspaces at once.

## 10. Left to the builder

- Exact CodeMirror package set and CSV highlighting approach.
- Toast/progress visual design (follow existing `--ch-*` tokens).
- Whether `fs.watch` recursive is reliable enough on Linux kernels in
  use, or whether `chokidar` is worth the dependency.
- How `data-viewer`'s table mode is folded into editor tabs (see 7.4).
- Icon set for the tree (reuse the webview's existing inline SVG style).
- Windows: confirm spawning `process.execPath` with
  `ELECTRON_RUN_AS_NODE` works for the worker threads (mupdf WASM) —
  else run import in the main process's own worker_threads, which is
  what happens today anyway.

## 11. Open items needing Lorenz

- **mupdf is AGPL-3.0** and ships inside the installer (as it already
  does in the `.vsix`). Acceptable alongside PolyForm Noncommercial? The
  plan proceeds on "yes, same as today"; a "no" swaps the PDF renderer.
- Apple Developer account and Windows code-signing certificate for
  signed builds (not blocking first release).
- Confirm the Linux targets: `.deb` + AppImage, or also `.rpm`.
