# Chronos v2 Standalone App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Chronos as a self-contained Electron desktop app in `chronos-v2/` — page viewer, chat, workspace file tree, editable tabs — with `pi` and the Chronos agent bundled inside the installer.

**Architecture:** Electron main process hosts the former VS Code extension logic (pi RPC session, HTTP push server, import pipeline, workspace management); the existing Lit webview is reused as the renderer and talks to main over the unchanged `ExtToWebview`/`WebviewToExt` envelopes via a preload bridge. `pi` runs as a child process of Electron's own Node (`ELECTRON_RUN_AS_NODE=1`) with an isolated config dir, loading the `chronos/` agent from the app bundle by explicit `--extension/--skill/--prompt-template` paths.

**Tech Stack:** Electron 45, electron-builder 26, esbuild, TypeScript, Lit 3, CodeMirror 6, mupdf (WASM) + pdf-lib, `node:test` + tsx for tests, Playwright (`_electron`) for the boot test.

**Spec:** `docs/superpowers/specs/2026-11-05-chronos-v2-standalone-design.md`

## Global Constraints

- New code lives only under `chronos-v2/` plus one line in `chronos/package.json` (typebox peer→dep). `chronos-vscode/` is not modified.
- Electron pinned `45.x`; electron-builder `26.x`; pi pinned to `@earendil-works/pi-coding-agent@0.84.4` (`piVersion` in `chronos-v2/package.json`).
- pi env set by the launcher, exactly: `ELECTRON_RUN_AS_NODE=1`, `PI_CODING_AGENT_DIR=<userData>/pi-agent`, `PI_CODING_AGENT_SESSION_DIR=<workspace>/sessions`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`, `CHRONOS_HTTP_PORT=<port>`, plus every `KEY=value` from `<workspace>/.chronos/.env`. Not `PI_OFFLINE` (it also blocks model-catalog refresh).
- pi args, exactly: `<cli.js> --mode rpc --extension <agent>/dist/extensions` followed by `--skill <workspace>/skills` only if that dir exists. No `--prompt-template`, no `--no-*` flags.
- The app never reads or writes `~/.pi`.
- No first-run network access or installs.
- pi 0.84's `message_update` carries no cumulative `message`; the chat assembles partials from `assistantMessageEvent` deltas (Task 2b). `message_end` is authoritative.
- Licence texts for Electron, pi (MIT), sharp (Apache-2.0), libvips (LGPL-3.0), mupdf (AGPL-3.0) ship in `resources/licenses/`.
- `.chronos/` is hidden from the file tree; `.chronos/.env` is written mode `0o600`.
- The webview's `styles.css` is copied, not rewritten; the app defines the 24 `--vscode-*` variables it consumes for light and dark.
- Commit author: Lorenz Hufe <lorenz.hufe@posteo.de>; no Co-Authored-By trailers (repo rule).
- esbuild does not typecheck: every task's verify step runs `npm run typecheck` (both tsconfigs) in addition to tests.

## Review Focus

1. A workspace path containing spaces or non-ASCII (e.g. `~/Dokumente/Kirchenbücher 1842/`) — pi must still spawn, the page image must still load over `chronos-file://`, and the file tree must list it. Test pinned in Task 6 (`encodes non-ascii and spaces`) and Task 3 (`launch args are passed unquoted as argv`).
2. A `chronos-file://` request for a path outside the open workspace (`../../.ssh/id_rsa`, or an absolute path elsewhere) must be refused with 403, never served. Test pinned in Task 6 (`rejects path outside root`, `rejects traversal`).
3. pi exits during a turn (crash, OOM) — the chat shows the `agentExited` banner with stderr, the restart menu item works, and pending `extension_ui_request`s are cancelled rather than leaking. Test pinned in Task 5 (`exit cancels pending ui requests`).
4. Closing an editor tab with unsaved changes, and saving to a file the agent rewrote meanwhile — the user must be prompted, never silently lose edits. Test pinned in Task 12 (`close dirty tab requires confirm`, `save detects on-disk change`).
5. Opening a folder that is not a Chronos workspace (no `sources/`), or a workspace with an interrupted import — the welcome flow must offer to initialise / resume rather than starting pi against junk. Test pinned in Task 7 (`isChronosWorkspace`) and Task 10 (`findIncompleteImports surfaces partial`).

---

## File structure

```
chronos-v2/
  package.json, electron-builder.yml, esbuild.mjs
  tsconfig.json            (main + preload + shared, CommonJS, node22 target)
  tsconfig.renderer.json   (renderer, ES2022, DOM)
  src/main/
    main.ts                app lifecycle; welcome vs main window; wires everything
    paths.ts               resolveVendorPaths() — dev vs packaged resource roots
    pi-launcher.ts         buildPiLaunch() — bin/args/env for pi
    env-file.ts            readEnvFile(), upsertEnvVar() (copied from chronos-panel.ts)
    agent-host.ts          AgentHost — ex ChronosPanel, Electron-free
    window-transport.ts    Transport impl over webContents.send
    protocol-handler.ts    chronos-file:// scheme + isAllowedPath()
    workspace.ts           initWorkspace(), isChronosWorkspace(), RecentStore
    files.ts               listDir(), readText(), writeText(), DirWatcher
    import/                import.ts (ex extension.ts import fns), pdf-worker.ts, pdf-split-worker.ts, pdf-stream.ts, import-status.ts
    login.ts               provider list, api-key + oauth handlers (ex chronos-panel.ts promptLogin/loginAnthropicSubscription)
    anthropic-oauth.ts     (copied)
    menu.ts                buildMenu()
    rpc/                   pi-rpc-session.ts (copied + args), rpc-types.ts (copied)
    http-server.ts, protocol.ts, sessions.ts, sources.ts   (copied)
    theme.ts               THEMES light/dark variable tables + injectTheme()
  src/preload/preload.ts   window.chronos bridge
  src/renderer/            copied from chronos-vscode/webview/ (main.ts, markdown.ts, styles.css, components/*, *.d.ts)
    index.html, welcome.html, welcome.ts
    components/file-tree.ts, center-tabs.ts, code-editor.ts, provider-dialog.ts
    tree-model.ts, tabs-model.ts   (pure, unit-tested)
  src/shared/webview-protocol.ts   (copied + extended)
  scripts/bundle-agent.mjs, scripts/rpc-canary.mjs
  test/                    *.test.ts (node:test), mock-pi.mjs (copied), fixtures/
  test/e2e/boot.spec.ts    Playwright electron boot test
  resources/               icon.png (copied from chronos-vscode), licenses/
```

---

### Task 1: Scaffold `chronos-v2/`

**Files:**
- Create: `chronos-v2/package.json`, `chronos-v2/tsconfig.json`, `chronos-v2/tsconfig.renderer.json`, `chronos-v2/esbuild.mjs`, `chronos-v2/.gitignore`
- Create: `chronos-v2/src/main/main.ts`, `chronos-v2/src/preload/preload.ts`, `chronos-v2/src/renderer/index.html`, `chronos-v2/src/renderer/main.ts` (placeholder, replaced in Task 4)
- Create: `chronos-v2/test/smoke.test.ts`
- Copy: `chronos-vscode/icon.png` → `chronos-v2/resources/icon.png`

**Interfaces:**
- Produces: npm scripts `build`, `watch`, `typecheck`, `test`, `start`, `dist`; esbuild entries `main`, `preload`, `renderer/main`, `renderer/welcome`, `pdf-worker`, `pdf-split-worker` → `out/`.
- `package.json` fields: `"main": "out/main.js"`, `"piVersion": "0.84.4"`, `"version": "0.3.0"`, `"type": "commonjs"`.
- Dependencies: `lit@^3.3`, `marked@^18`, `dompurify@^3.4`, `mupdf@^1.27`, `pdf-lib@^1.17`, `dotenv@^16`, `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/language`, `@codemirror/lang-json`, `@codemirror/lang-markdown`, `@codemirror/lang-yaml`, `@codemirror/theme-one-dark`.
- DevDependencies: `electron@^45`, `electron-builder@^26`, `esbuild@^0.25`, `typescript@^5.9`, `tsx@^4`, `@types/node@^22`, `@playwright/test@^1.50`, `@earendil-works/pi-coding-agent@0.84.4` (dev: vendored by Task 3, used directly in `npm run dev`).

- [ ] **Step 1: Write the failing smoke test** — `test/smoke.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
const out = join(__dirname, "..", "out");
test("build emits all bundles", () => {
  for (const f of ["main.js", "preload.js", "renderer/main.js", "renderer/main.css", "renderer/welcome.js", "pdf-worker.js", "pdf-split-worker.js"])
    assert.ok(existsSync(join(out, f)), f);
});
```

- [ ] **Step 2: Run it to verify it fails** — `cd chronos-v2 && npm test` → FAIL (no `out/`). Script: `"test": "node --import tsx --test \"test/**/*.test.ts\""`.

- [ ] **Step 3: Write `esbuild.mjs`** — two contexts as in `chronos-vscode/esbuild.mjs`: node context (`main`, `preload`, `pdf-worker`, `pdf-split-worker`; `format: cjs`, `platform: node`, `target: node22`, `external: ["electron", "mupdf"]`) and browser context (`renderer/main`, `renderer/welcome`; `format: iife`, `target: es2022`, loaders `.woff2: file`, `.png: dataurl`, `.css` bundled). `--watch` flag as before. Copy `src/renderer/*.html` to `out/renderer/` in the build.

- [ ] **Step 4: Write minimal `main.ts`, `preload.ts`, `index.html`, renderer `main.ts`** — `main.ts`: `app.whenReady()` → `new BrowserWindow({ width: 1400, height: 900, title: "Chronos", webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, sandbox: false } })` loading `out/renderer/index.html`. `preload.ts`: `contextBridge.exposeInMainWorld("chronos", { version: process.versions.electron })`. Renderer prints "Chronos v2" into `document.body`. Placeholders for the two worker entries and `welcome.ts` are empty modules (filled in Tasks 10 and 7).

- [ ] **Step 5: Write the two tsconfigs** — `tsconfig.json`: `include: ["src/main", "src/preload", "src/shared", "test", "scripts"]`, `module: node16`, `target: es2022`, `strict`, `noEmit`. `tsconfig.renderer.json`: `include: ["src/renderer", "src/shared"]`, `module: esnext`, `lib: ["es2022","dom","dom.iterable"]`, `experimentalDecorators: true`, `useDefineForClassFields: false` (Lit requirement, same as `chronos-vscode/webview/tsconfig.json`). Script `"typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.renderer.json"`.

- [ ] **Step 6: Verify** — `npm install && npm run build && npm test && npm run typecheck` → all PASS. `npm start` (= `electron .`) opens a window titled Chronos showing "Chronos v2".

- [ ] **Step 7: Commit** — `git add chronos-v2 && git commit -m "feat(v2): scaffold Electron app"`.

---

### Task 2: Copy the host-neutral modules

**Files:**
- Copy (verbatim unless noted) from `chronos-vscode/src/`: `rpc/rpc-types.ts`, `rpc/pi-rpc-session.ts` (modified), `http-server.ts`, `protocol.ts`, `panel/sessions.ts` → `sessions.ts`, `panel/sources.ts` → `sources.ts`, `anthropic-oauth.ts`, `pdf-stream.ts`, `pdf-worker.ts`, `pdf-split-worker.ts`, `import-status.ts` → `import/`; `panel/webview-protocol.ts` → `src/shared/webview-protocol.ts` (fix its import to `../main/rpc/rpc-types`).
- Copy: `chronos-vscode/test/mock-pi.mjs` → `chronos-v2/test/mock-pi.mjs`.
- Create: `chronos-v2/test/pi-rpc-session.test.ts`.

**Interfaces:**
- Modify `PiRpcSessionOptions` to `{ piBin: string; args: string[]; workspaceDir: string; env: Record<string,string> }`; `spawn(piBin, args, …)` replaces the hard-coded `["--mode","rpc"]`. Everything else unchanged: `start(): Promise<RpcSessionState>`, `stop()`, `request<T>(cmd, timeoutMs?)`, `sendUiResponse()`, `onEvent/onUiRequest/onExit`.
- Modify `rpc-types.ts`: `message_update` becomes `{ type: "message_update"; assistantMessageEvent: AssistantMessageEvent; usage?: Usage }` (no `message`). `AssistantMessageEvent` is typed locally (no pi import) as the union of `start`, `text_start|thinking_start|toolcall_start {contentIndex}`, `text_delta|thinking_delta|toolcall_delta {contentIndex; delta}`, `text_end|thinking_end {contentIndex; content}`, `toolcall_end {contentIndex; toolCall}`, `done {reason}`, `error {reason; error}` — the `partial` field pi still sends is ignored.
- Modify `test/mock-pi.mjs`: the echo scenario emits `message_start`, then `text_start`/two `text_delta`/`text_end` `message_update`s in the 0.84 shape, then `message_end`.

- [ ] **Step 1: Write the failing test** — `test/pi-rpc-session.test.ts`:

```ts
test("starts mock pi with explicit args and answers get_state", async () => {
  const s = new PiRpcSession({ piBin: process.execPath, args: [join(__dirname, "mock-pi.mjs"), "--mode", "rpc"], workspaceDir: fixtureDir, env: {} });
  const state = await s.start();
  assert.equal(state.model.id, "mock-model");
  await s.stop();
});
```

- [ ] **Step 2: Run** — `npm test` → FAIL (module not found).
- [ ] **Step 3: Copy the files and apply the `args` change.** Worker entry points in `esbuild.mjs` now point at `src/main/import/pdf-worker.ts` / `pdf-split-worker.ts`.
- [ ] **Step 4: Verify** — `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(v2): import host-neutral modules from the extension"`.

---

### Task 2b: Streaming delta assembly in the chat

**Files:**
- Create: `src/renderer/stream-assembler.ts`; Modify: `src/renderer/components/chronos-chat.ts` (~421–440)
- Test: `test/stream-assembler.test.ts`

**Interfaces:**
- `class StreamAssembler { start(message: AssistantMessage): void; apply(ev: AssistantMessageEvent): AssistantMessage /* returns a fresh partial */; end(message: AssistantMessage): AssistantMessage; get current(): AssistantMessage | null }`. Content blocks are keyed by `contentIndex`: `text_*` → `{type:"text", text}`, `thinking_*` → `{type:"thinking", thinking}`, `toolcall_*` → `{type:"toolCall", …}` filled from `toolcall_end.toolCall` (deltas accumulate raw JSON text in a side buffer, not rendered).
- `chronos-chat.ts`: `message_start` (assistant) → `assembler.start(event.message)` and push/replace the streaming item; `message_update` → replace the item's message with `assembler.apply(ev)`; `message_end` → `assembler.end(event.message)` and `streaming: false`. Non-assistant messages keep today's behaviour.

- [ ] **Step 1: Failing tests** — `text deltas accumulate per contentIndex`, `thinking and text interleave by index`, `end replaces with authoritative message`, `apply before start is a no-op returning null`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `npm test && npm run typecheck` PASS; `npm run dev` against the real pi 0.84.4 shows text appearing incrementally.
- [ ] **Step 5: Commit** — `git commit -m "feat(v2): assemble streamed assistant messages from pi 0.84 deltas"`.

---

### Task 3: pi launcher, vendoring script, RPC canary

**Files:**
- Create: `src/main/paths.ts`, `src/main/pi-launcher.ts`, `src/main/env-file.ts`, `scripts/bundle-agent.mjs`, `scripts/rpc-canary.mjs`
- Modify: `chronos/package.json` (move `@sinclair/typebox` from `peerDependencies` to `dependencies`, pinned `^0.34`; keep the two pi peers) and `chronos/package-lock.json` (`npm install` so the dev pi peers resolve to 0.84.4; run `cd chronos && npm run build` to confirm the agent still compiles against 0.84 types)
- Test: `test/pi-launcher.test.ts`, `test/env-file.test.ts`

**Interfaces:**
- `paths.ts`: `interface VendorPaths { piCli: string; agentDir: string }`; `resolveVendorPaths(opts: { isPackaged: boolean; resourcesPath: string; appRoot: string }): VendorPaths`. Packaged → `<resourcesPath>/vendor/pi/dist/bundle/cli.js` and `<resourcesPath>/vendor/chronos`; dev → `<appRoot>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` and `<appRoot>/../chronos`.
- `pi-launcher.ts`: `interface PiLaunch { bin: string; args: string[]; env: Record<string,string> }`; `buildPiLaunch(opts: { vendor: VendorPaths; workspaceDir: string; userDataDir: string; httpPort: number; execPath: string }): PiLaunch` producing exactly the Global Constraints args/env; `bin` = `opts.execPath`. `env` contains only the variables listed in Global Constraints (the session merges `process.env` itself).
- `env-file.ts`: `readEnvFile(path): Record<string,string>` and `upsertEnvVar(path, key, value): void` (moved from `chronos-panel.ts:46-62` and `extension.ts:258`).
- `bundle-agent.mjs`: `node scripts/bundle-agent.mjs` → populates `chronos-v2/vendor/{pi,chronos}` (gitignored): builds `../chronos` (`npm ci --omit=dev --omit=peer && npm run build`), copies `dist prompts skills package.json node_modules`; copies the installed `node_modules/@earendil-works/pi-coding-agent` whole (`package.json`, `dist/` incl. `dist/bundle/chunks/`, `node_modules/`) after asserting its version equals `piVersion`. Copies licence texts to `resources/licenses/`: pi `LICENSE`, `sharp/LICENSE`, `@img/sharp-libvips-*/LICENSE` (LGPL), `mupdf/LICENSE` (AGPL), each named `<package>.txt`.
- `rpc-canary.mjs`: like `chronos-vscode/scripts/rpc-spike.mjs` but spawns via `buildPiLaunch` (import from `out/`), in a temp fixture workspace; asserts `get_state` answers, `select-source` is in `get_commands`, `get_available_models` returns an array, and that no slash command named after a `chronos/prompts/*.md` file (e.g. `system-prompt`) is registered. Script `"canary": "node scripts/rpc-canary.mjs"`.

- [ ] **Step 1: Write failing tests**

```ts
test("launch args are passed unquoted as argv", () => {
  const l = buildPiLaunch({ vendor: { piCli: "/x/cli.js", agentDir: "/a" }, workspaceDir: "/w s/Kirchenbücher", userDataDir: "/u", httpPort: 4242, execPath: "/e" });
  assert.deepEqual(l.args, ["/x/cli.js", "--mode", "rpc", "--extension", "/a/dist/extensions"]);
  assert.equal(l.env.PI_CODING_AGENT_DIR, join("/u", "pi-agent"));
  assert.equal(l.env.ELECTRON_RUN_AS_NODE, "1"); assert.equal(l.env.PI_SKIP_VERSION_CHECK, "1"); assert.equal(l.env.PI_TELEMETRY, "0"); assert.equal(l.env.PI_OFFLINE, undefined);
  assert.equal(l.env.CHRONOS_HTTP_PORT, "4242");
});
test("adds workspace skills dir and .env keys when present", ...);   // mkdtemp with skills/ and .chronos/.env ANTHROPIC_API_KEY=k → args end with "--skill", "<ws>/skills"; env.ANTHROPIC_API_KEY === "k"
test("resolveVendorPaths packaged vs dev", ...);
test("upsertEnvVar replaces existing key and keeps mode 0600", ...);
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement the four modules and the typebox change.**
- [ ] **Step 4: Verify** — `npm test && npm run typecheck` PASS; `npm run bundle-agent && npm run build && npm run canary` → prints `OK: state, select-source, N models` against the real pinned pi (needs no API key: models list comes from pi's registry). If `select-source` is missing, the `--extension` dir path is wrong — fix the launcher, not the canary.
- [ ] **Step 5: Commit** — `git commit -m "feat(v2): pi launcher, agent vendoring, rpc canary"` (include `chronos/package.json`).

---

### Task 4: Renderer port — preload bridge, theme, app shell in Electron

**Files:**
- Copy `chronos-vscode/webview/` → `src/renderer/` (`components/*`, `markdown.ts`, `styles.css`, `css.d.ts`, `assets.d.ts`, any assets). Fix imports of `../../src/panel/webview-protocol` → `../../shared/webview-protocol`, and of `rpc-types` likewise.
- Modify: `src/renderer/main.ts`, `src/preload/preload.ts`, `src/renderer/index.html`
- Create: `src/main/theme.ts`, `src/main/window-transport.ts`
- Test: `test/theme.test.ts`

**Interfaces:**
- `preload.ts` exposes `window.chronos: { postMessage(msg: WebviewToExt): void; onMessage(cb: (msg: ExtToWebview) => void): void; getState(): unknown; setState(s: unknown): void }`. IPC channels: renderer→main `"chronos:msg"`, main→renderer `"chronos:msg"`. `getState/setState` use `localStorage["chronos.uiState"]` (JSON) — no IPC.
- `theme.ts`: `type ThemeName = "light"|"dark"`; `THEMES: Record<ThemeName, Record<string,string>>` keyed by the 24 variable names in `styles.css` (list them with `grep -oE "var\(--vscode-[a-zA-Z-]+" styles.css | sort -u`); `themeCss(name): string` returns `:root{--vscode-…:…;}`; `resolveTheme(pref: "system"|ThemeName, nativeDark: boolean): ThemeName`.
- `window-transport.ts`: `class WindowTransport implements Transport { constructor(win: BrowserWindow); post(msg: ExtToWebview): void }` where `interface Transport { post(msg: ExtToWebview): void }` is declared in `agent-host.ts` (Task 5 — declare it in `src/main/transport.ts` here so both tasks compile).
- `ExtToWebview` gains `{ type: "theme"; name: ThemeName }`; renderer applies it by setting `document.documentElement.dataset.theme` and injecting `themeCss` text received in the same message (`css: string`).

- [ ] **Step 1: Failing test** — `test/theme.test.ts`: `themeCss("dark")` contains every variable name consumed by `styles.css` (read the file, extract the set, assert each is defined in both themes); `resolveTheme("system", true) === "dark"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Copy the webview, rewrite `renderer/main.ts`** to use `window.chronos` exactly where it used `acquireVsCodeApi()`; declare the global in `src/renderer/chronos-api.d.ts`. `index.html` has a CSP `default-src 'none'; img-src chronos-file: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'`.
- [ ] **Step 4: Implement `theme.ts`, `window-transport.ts`, `preload.ts`**; in `main.ts` send `theme` after `did-finish-load` and on `nativeTheme.on("updated")`.
- [ ] **Step 5: Verify** — tests + typecheck PASS; `npm start` shows the full three-component layout (header, Page/Data tabs, chat) styled in the OS theme, with the chat's "agent not running" state (nothing started yet).
- [ ] **Step 6: Commit** — `git commit -m "feat(v2): port webview into Electron renderer with preload bridge and themes"`.

---

### Task 5: AgentHost (port of ChronosPanel)

**Files:**
- Create: `src/main/agent-host.ts`, `src/main/transport.ts` (if not in Task 4)
- Modify: `src/main/main.ts` (construct AgentHost for the opened workspace; for now a hard-coded `--workspace <dir>` CLI arg)
- Test: `test/agent-host.test.ts` (uses `test/mock-pi.mjs` via a `launch` override)

**Interfaces:**
- `class AgentHost { constructor(opts: { workspaceDir: string; transport: Transport; launch: (httpPort: number) => PiLaunch; imageUri: (absPath: string) => string; onTitle?: (t: string) => void; onAttention?: () => void }); start(): Promise<void>; stop(): Promise<void>; handleWebviewMessage(msg: WebviewToExt): Promise<void>; refreshSources(): void; get status(): "idle"|"starting"|"ready"|"failed"|"exited"; restart(): Promise<void>; newSession(): Promise<void>; showPageById(sourceName: string, pageId: number): void; onStateChange(cb: (s: { models: ModelInfo[]; currentModel?: string; thinking: ThinkingLevel; yolo: boolean }) => void): () => void }`
- Ports `chronos-panel.ts` methods 1:1 except: `vscode.window.showErrorMessage` → `transport.post({type:"notify",level:"error",…})`; `panel.reveal` → no-op callback `opts.onAttention?.()`; `promptLogin`/`loginAnthropicSubscription` are NOT ported here (Task 8; the `"login"` case posts `{ type: "login/open" }` — add to `ExtToWebview` now); `pageImageUri` → `opts.imageUri(path)`; `setTitle` → `opts.onTitle`. Owns the `HttpServer` (`start()` binds it and passes its `port` into `launch(port)`). Test seams `testInvoke/testDump` kept.

- [ ] **Step 1: Failing tests**

```ts
test("start seeds webview with state, models, commands, sources, sessions", …);  // collect posted msgs; assert types in order appear
test("show_page over http posts viewer/showPage with imageUri from callback", …); // POST to http://127.0.0.1:<port>/message
test("exit cancels pending ui requests", …);  // send a prompt that makes mock-pi emit extension_ui_request select; then kill the child; assert the mock received extension_ui_response cancelled (mock-pi writes a line to stderr on it — add that to mock-pi) and transport got agentExited
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `agent-host.ts`** by moving code from `chronos-panel.ts:235-949` with the substitutions above. Keep `readChronosSettings`, `commandMatchesPrefix`, `suggestPrefix`, `writeChronosSettings` (yolo/allowedCommands) in `src/main/chronos-settings.ts`.
- [ ] **Step 4: Wire `main.ts`**: on window ready, `new AgentHost({...}).start()`; forward `ipcMain.on("chronos:msg")` to `handleWebviewMessage`.
- [ ] **Step 5: Verify** — tests + typecheck PASS; `npm run dev -- --workspace <a real workspace>` chats with the real agent, `show_page` renders in the viewer (image via Task 6 — until then expect a broken image; that is fine).
- [ ] **Step 6: Commit** — `git commit -m "feat(v2): AgentHost — pi session, HTTP push, webview bridge"`.

---

### Task 6: `chronos-file://` protocol

**Files:**
- Create: `src/main/protocol-handler.ts`; Modify: `src/main/main.ts`
- Test: `test/protocol-handler.test.ts`

**Interfaces:**
- `isAllowedPath(root: string, candidate: string): boolean` — true iff `path.resolve(candidate)` is inside `path.resolve(root)` (realpath both; symlink escapes refused).
- `toChronosFileUrl(absPath: string): string` → `chronos-file:///` + each path segment `encodeURIComponent`-ed (Windows: drive letter kept, backslashes → `/`).
- `fromChronosFileUrl(url: string): string` inverse.
- `registerChronosFileProtocol(getRoots: () => string[]): void` — `protocol.registerSchemesAsPrivileged([{ scheme: "chronos-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])` before `app.ready`; after ready `protocol.handle("chronos-file", …)` serving `net.fetch(pathToFileURL(p))` when `isAllowedPath` for any root, else `new Response(null, { status: 403 })`.

- [ ] **Step 1: Failing tests** — `encodes non-ascii and spaces` (round-trip `/w s/Kirchenbücher/png/page_0001.png`), `rejects path outside root`, `rejects traversal` (`root/../etc`), `allows nested`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** AgentHost's `imageUri` in `main.ts` = `toChronosFileUrl`; verify page images render in `npm run dev`. Tests + typecheck PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(v2): chronos-file protocol scoped to the workspace"`.

---

### Task 7: Workspaces — open, create, recent, welcome window

**Files:**
- Create: `src/main/workspace.ts`, `src/renderer/welcome.html`, `src/renderer/welcome.ts`, `src/renderer/welcome.css`
- Modify: `src/main/main.ts` (welcome window when no workspace; `--workspace` arg still honoured)
- Test: `test/workspace.test.ts`

**Interfaces:**
- `workspace.ts`: `initWorkspace(folder: string): Promise<void>` (moved verbatim from `extension.ts:277-359`, sans vscode); `isChronosWorkspace(folder): boolean` (has `sources/` dir or `.chronos/` dir); `class RecentStore { constructor(file: string); list(): { path: string; openedAt: number }[]; add(path): void /* dedupe, newest first, max 10, drop missing dirs on list() */ }` stored at `<userData>/recent.json`.
- Welcome window IPC (preload also serves it; same `window.chronos`): renderer→main `{ type: "workspace/open" }`, `{ type: "workspace/create" }`, `{ type: "workspace/openRecent"; path }`; main→renderer `{ type: "workspace/recent"; items }`. Add these to the protocol types under a `WelcomeToExt`/`ExtToWelcome` pair in `webview-protocol.ts`.
- Flow: open → `dialog.showOpenDialog({properties:["openDirectory"]})`; if `!isChronosWorkspace` → `dialog.showMessageBox` "Not a Chronos workspace. Initialise it?" [Initialise, Cancel] → `initWorkspace`. create → pick folder (may be empty) → `initWorkspace`. Then `openMainWindow(path)`: closes welcome, creates main window, `RecentStore.add`, starts AgentHost. Closing the main window returns to welcome.

- [ ] **Step 1: Failing tests** — `initWorkspace creates sources memory skills sessions .chronos .pi and MEMORY.MD`, `isChronosWorkspace`, `RecentStore dedupes, caps at 10, drops missing`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `workspace.ts`, welcome page (plain Lit, two buttons + recent list, same theme variables), and `main.ts` window orchestration. **Step 4:** tests + typecheck PASS; `npm start` with no args shows welcome; opening a workspace shows the main window and starts the agent.
- [ ] **Step 5: Commit** — `git commit -m "feat(v2): welcome window, open/create/recent workspaces"`.

---

### Task 8: Provider login

**Files:**
- Create: `src/main/login.ts`, `src/renderer/components/provider-dialog.ts`
- Modify: `src/main/agent-host.ts` (`"login"` → `login/open`), `src/renderer/components/chronos-app.ts` (render `<chronos-provider-dialog>` when `login/open` arrives), `src/shared/webview-protocol.ts`
- Test: `test/login.test.ts`

**Interfaces:**
- Protocol: `ExtToWebview` += `{ type: "login/open"; providers: { id: string; label: string; envVar: string }[] }`, `{ type: "login/oauthStatus"; status: "waiting"|"done"|"error"; message?: string }`. `WebviewToExt` += `{ type: "login/apiKey"; envVar: string; key: string }`, `{ type: "login/oauth" }`, `{ type: "login/oauthCode"; code: string }` (manual-paste fallback as today), `{ type: "login/cancel" }`.
- `login.ts`: `PROVIDERS` (moved from `chronos-panel.ts:33-44`); `saveApiKey(workspaceDir, envVar, key): void` (uses `upsertEnvVar`); `startAnthropicOauth(opts: { authDir: string; openExternal: (url) => void; onStatus: (s) => void }): Promise<void>` — port of `loginAnthropicSubscription` writing `auth.json` under `<PI_CODING_AGENT_DIR>` (not `~/.pi`). After either path, `AgentHost.restart()`.
- `provider-dialog.ts`: modal with provider `<select>`, key `<input type=password>`, "Use Claude subscription" button, cancel. Uses existing `.control-select`/`.header-btn` classes.

- [ ] **Step 1: Failing tests** — `saveApiKey writes KEY to .chronos/.env mode 0600`, `oauth writes auth.json under authDir` (stub token endpoint via `PI_OAUTH_CALLBACK_HOST`-style injection: give `startAnthropicOauth` an `exchange` function param defaulting to the real one).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** tests + typecheck PASS; manual: API-key path restarts agent and models list populates.
- [ ] **Step 5: Commit** — `git commit -m "feat(v2): in-app provider login (API key + Claude OAuth)"`.

---

### Task 9: Application menu

**Files:**
- Create: `src/main/menu.ts`; Modify: `src/main/main.ts`
- Test: `test/menu.test.ts`

**Interfaces:**
- `buildMenu(actions: MenuActions, state: { models: ModelInfo[]; currentModel?: string; thinking: ThinkingLevel; yolo: boolean; theme: "system"|ThemeName; hasWorkspace: boolean }): MenuItemConstructorOptions[]` where `MenuActions` is `{ newWorkspace; openWorkspace; openRecent(path); importSources; closeWorkspace; newSession; resumeSession; restartAgent; showPage; login; setModel(provider, id); setThinking(level); toggleYolo; toggleTree; toggleChat; setTheme(t); zoomIn; zoomOut; zoomReset; openDocs; openDiscord; reportIssue; showLogs; about }` (all `() => void` unless shown).
- Menus exactly as spec §7.6. `about` shows `dialog.showMessageBox` with app version, `piVersion`, agent version (`vendor/chronos/package.json`), Electron, Node. `showLogs` → `shell.showItemInFolder(app.getPath("logs"))`. `resumeSession` and `showPage` post `{type:"__test/invoke", action:"openHistory"}`-style messages? No — add `ExtToWebview` `{ type: "ui/openDrawer"; drawer: "history" }` and `{ type: "ui/toggle"; pane: "tree"|"chat" }`; `showPage` uses `dialog`-free renderer prompt `{ type: "ui/promptShowPage" }`.
- `main.ts` subscribes to `AgentHost.onStateChange` (Task 5) and rebuilds the menu when models/model/thinking/yolo change.

- [ ] **Step 1: Failing test** — `buildMenu` returns File/Session/Agent/View/Help in order; Agent▸Model has one radio item per model with the current one checked; items disabled when `hasWorkspace` is false (Session, Agent, Import, Close).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; renderer handles `ui/openDrawer`, `ui/toggle`, `ui/promptShowPage` in `chronos-app.ts`. **Step 4:** tests + typecheck PASS; manual click-through. **Step 5: Commit** — `git commit -m "feat(v2): application menu"`.

---

### Task 10: Import pipeline

**Files:**
- Create: `src/main/import/import.ts` (move `extension.ts:361-700` sans vscode)
- Modify: `src/main/main.ts` (menu `importSources`; resume prompt on workspace open), `src/shared/webview-protocol.ts`, `src/renderer/components/chronos-app.ts` (progress bar in header)
- Test: `test/import.test.ts`

**Interfaces:**
- `importFiles(files: string[], sourcesDir: string, workerScript: string, progress: ProgressSink): Promise<ImportResult>`; `importFolder(folder, …)`; `findIncompleteImports` re-exported; `resumeIncompleteImports(incompletes, sourcesDir, workerScript, progress)`; `type ProgressSink = (p: { id: string; title: string; done: number; total?: number; message?: string }) => void`.
- Protocol: `ExtToWebview` += `{ type: "progress"; id: string; title: string; done: number; total?: number; message?: string; finished?: boolean }`.
- `main.ts`: `importSources` → `showMessageBox` [Files, Folder] → `showOpenDialog` (filters pdf/png/jpg/jpeg/tif/tiff as `SUPPORTED_EXTS`) → `importFiles` → `AgentHost.refreshSources()` → notify summary. On workspace open: `findIncompleteImports` → `showMessageBox` Resume/Discard/Later (text from `extension.ts:686-692`).

- [ ] **Step 1: Failing tests** — `importFiles renders a 2-page pdf to page_0001/0002.png` (build the PDF in-test with `pdf-lib`), `findIncompleteImports surfaces partial` (create `.png.partial/` + `.importing.json`, assert returned with `renderedPages`), `progress sink receives done==total at end`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Worker script path = `join(__dirname, "pdf-worker.js")` (esbuild emits beside `main.js`). **Step 4:** tests + typecheck PASS; manual import of a real PDF shows the bar and the source appears in the picker. **Step 5: Commit** — `git commit -m "feat(v2): PDF/image import with progress and crash resume"`.

---

### Task 11: File tree

**Files:**
- Create: `src/main/files.ts`, `src/renderer/tree-model.ts`, `src/renderer/components/file-tree.ts`
- Modify: `src/main/main.ts` / `agent-host.ts` (route tree messages), `src/shared/webview-protocol.ts`, `src/renderer/components/chronos-app.ts` (left pane + splitter; `getUiState` gains `treeWidth` and `treeHidden`), `src/renderer/styles.css` (pane rules only, appended)
- Test: `test/files.test.ts`, `test/tree-model.test.ts`

**Interfaces:**
- Protocol as spec §7.3: `TreeEntry = { path: string; name: string; kind: "dir"|"file"; size?: number }`; `tree` (root + top-level entries), `tree/children` `{ path; entries }` (reply to `tree/expand`), `tree/changed`, `file/revealInOs`, `file/open` (routing in Task 12; here `file/open` on a PNG under `sources/<s>/png/page_NNNN.*` calls `AgentHost.showPageById`).
- `files.ts`: `listDir(dir: string, root: string): TreeEntry[]` — dirs first, `localeCompare`, hides names starting with `.`; `class DirWatcher { constructor(root, onChange: (e: { path; kind }) => void); watch(dir): void; close(): void }` — `fs.watch` per expanded dir, 300 ms debounce per path.
- `tree-model.ts`: `class TreeModel { setRoot(root, entries); setChildren(path, entries); toggle(path); applyChange(e); visible(): { entry: TreeEntry; depth: number; expanded: boolean }[] }`.

- [ ] **Step 1: Failing tests** — `listDir hides dotdirs and sorts dirs first`, `TreeModel toggle expands/collapses and visible() flattens with depth`, `applyChange add inserts sorted / unlink removes`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**, including context menu (`Open`, `Reveal in OS`, `Copy path`; on `sources/`: `Import sources…` → `workspace/import`). Selected source marker from the `sources` message. **Step 4:** tests + typecheck PASS; manual: tree shows, expands, updates when the agent writes `data/*.csv`. **Step 5: Commit** — `git commit -m "feat(v2): workspace file tree"`.

---

### Task 12: Center tabs and editor

**Files:**
- Create: `src/renderer/tabs-model.ts`, `src/renderer/components/center-tabs.ts`, `src/renderer/components/code-editor.ts`
- Modify: `src/renderer/components/chronos-app.ts` (replace the `pv-tabs` strip with `<chronos-center-tabs>`; Page + Data become the two permanent tabs), `src/main/files.ts` (`readText`, `writeText`, `statMtime`), `src/main/agent-host.ts` / `main.ts` (route `file/open`, `file/save`), `src/shared/webview-protocol.ts`
- Test: `test/tabs-model.test.ts`, `test/files.test.ts` (extend)

**Interfaces:**
- Protocol: `file/content { path; content; mtimeMs; readOnly }`, `file/saved { path; ok; mtimeMs?; error? }`, `WebviewToExt file/save { path; content; expectedMtimeMs }` → main refuses with `error: "changed-on-disk"` when `stat.mtimeMs !== expectedMtimeMs`; renderer then prompts Overwrite / Reload.
- `tabs-model.ts`: `type Tab = { id: string; kind: "page"|"data"|"editor"|"image"; path?: string; title: string; dirty: boolean; mtimeMs?: number }`; `class TabsModel { tabs; activeId; open(tab): Tab /* focuses existing by path */; close(id): "closed"|"needs-confirm"; forceClose(id); activate(id); markDirty(id, dirty); }` — `page` and `data` tabs are never closable.
- `code-editor.ts`: Lit element wrapping CodeMirror 6 `EditorView`; `language` by extension (`.json` → lang-json, `.md` → lang-markdown, `.yaml/.yml` → lang-yaml, `.csv/.txt/other` → plain); emits `dirty-changed` and `save-requested` (Ctrl/Cmd+S) events; `oneDark` theme when `data-theme="dark"`.
- `file/open` routing in main: `sources/**/png/page_NNNN.(png|jpg|jpeg)` → `showPageById`; other `.png/.jpg/.jpeg` → `file/content` with `readOnly: true` and renderer opens an `image` tab using `chronos-file://`; text extensions (`csv json md yaml yml txt skill`) → editor tab; else `shell.openPath`.

- [ ] **Step 1: Failing tests** — `close dirty tab requires confirm`, `open same path focuses existing`, `page and data tabs cannot close`, `writeText with stale expectedMtime returns changed-on-disk`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Tabs + active tab + open editor paths join `getUiState`. **Step 4:** tests + typecheck PASS; manual: open `memory/MEMORY.MD`, edit, save, agent `show_page` pulls the Page tab forward. **Step 5: Commit** — `git commit -m "feat(v2): tabbed center pane with CodeMirror editor"`.

---

### Task 13: Packaging

**Files:**
- Create: `chronos-v2/electron-builder.yml`, `.github/workflows/v2-release.yml`, `chronos-v2/resources/licenses/` (populated by `bundle-agent.mjs`)
- Modify: `chronos-v2/package.json` (`dist` script, `build` runs `bundle-agent` first)

**Interfaces:**
- `electron-builder.yml`: `appId: org.ai-historian.chronos`, `productName: Chronos`, `files: ["out/**", "package.json", "node_modules/mupdf/**"]`, `extraResources: [{ from: "vendor", to: "vendor" }, { from: "resources/licenses", to: "licenses" }]` (extraResources never enter the asar, so `vendor/` is not also listed under asarUnpack), `asarUnpack: ["out/pdf-worker.js", "out/pdf-split-worker.js", "node_modules/mupdf/**"]`, `linux: { target: ["deb", "AppImage"], category: "Office", icon: resources/icon.png }`, `mac: { target: [{ target: "dmg", arch: ["universal"] }], category: public.app-category.productivity, hardenedRuntime: true, notarize: false }`, `win: { target: ["nsis"] }`, `publish: { provider: "github", owner: ai-historian, repo: chronos }`. Signing only if `CSC_LINK` present (electron-builder default).
- Workflow: on tag `v2-*`, matrix ubuntu/macos/windows, `npm ci && npm run build && npx electron-builder --publish always`.

- [ ] **Step 1: Verify failing** — `npm run dist` errors (no config).
- [ ] **Step 2: Write config + workflow.** `paths.ts` already handles `app.isPackaged`.
- [ ] **Step 3: Verify** — `npm run dist -- --linux AppImage` produces `dist/Chronos-0.3.0.AppImage`; running it on a fresh fixture workspace: welcome → open → chat answers (with an API key) and `show_page` renders; `About` shows pi 0.84.4. `du -sh` the AppImage and record it in the commit message.
- [ ] **Step 4: Commit** — `git commit -m "build(v2): electron-builder targets and release workflow"`.

---

### Task 14: Boot test, docs

**Files:**
- Create: `chronos-v2/test/e2e/boot.spec.ts`, `chronos-v2/playwright.config.ts`, `chronos-v2/README.md`
- Modify: `CLAUDE.md` (new "chronos-v2/" section: build/test commands, the Electron host/renderer split, the vendor/ rule; also correct the stale "0.79 API" note to 0.84 and mention the `message_update` delta shape), `README.md` (a "Standalone app" install section above the VS Code one, linking the releases page)

**Interfaces:**
- `boot.spec.ts`: `_electron.launch({ args: ["out/main.js", "--workspace", fixture], env: { CHRONOS_PI_LAUNCH_OVERRIDE: JSON.stringify({ bin: process.execPath, args: [mockPi, "--mode", "rpc"] }) } })`. Add that env override to `main.ts` (test-only, documented). Asserts: window title "Chronos"; `chronos-file-tree`, `chronos-center-tabs`, `chronos-chat` elements present; `__test/dump` state (via `page.evaluate` on the app element) shows `models[0].id === "mock-model"`; `page.locator("img.page-image")` has `src` starting `chronos-file://` after invoking `select: TestSource`.
- Script `"test:e2e": "playwright test"`.

- [ ] **Step 1: Write the spec, run** → FAIL (no override). **Step 2: Implement override + any missing hooks.** **Step 3:** `npm run build && npm run test:e2e` PASS. **Step 4:** write docs. **Step 5: Commit** — `git commit -m "test(v2): Electron boot test; docs"`.
