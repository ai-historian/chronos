# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Chronos is an AI agent that helps historians extract structured data from scanned primary sources. It is split into **two independently-built npm packages**:

- **`chronos/`** — a [`pi`](https://github.com/badlogic/pi-mono) **pi-package**: the agent itself (custom tools, prompts, lifecycle hooks). It is *not* a standalone program — it is loaded into the user's globally-installed `pi` agent at runtime.
- **`chronos-vscode/`** — the VS Code extension: a host process (`src/`) plus a Lit web-component UI (`webview/`) that drives a `pi` subprocess and renders the page viewer + chat.
- **`chronos-v2/`**: the standalone Electron app (Chronos v2). It bundles pi and the `chronos/` agent and does not need VS Code. See the `chronos-v2/` section below.

The repo root is also a pi-package wrapper (`package.json` `pi` field points into `chronos/`), so `pi install <repo>` registers the agent.

## Build / test / typecheck

```bash
# chronos pi-package — compiles TS to dist/ (pi loads from dist/, see gotcha below)
cd chronos && npm run build            # = tsc

# VS Code extension — esbuild bundles BOTH the host and the webview into out/
cd chronos-vscode && npm run build     # one-shot
cd chronos-vscode && npm run watch     # rebuild on change
cd chronos-vscode && npm run package   # vsce package -> .vsix
```

**esbuild does not type-check.** After editing extension/webview TS, verify types explicitly — there are two tsconfigs:

```bash
cd chronos-vscode && npx tsc --noEmit -p tsconfig.json          # host (src/)
cd chronos-vscode && npx tsc --noEmit -p webview/tsconfig.json  # webview/
```

Tests live in `chronos-vscode/` (no unit-test runner; two node scripts):

```bash
node scripts/rpc-spike.mjs [path-to-pi]   # canary: asserts the pi --mode rpc JSONL contract. Run after upgrading the global pi.
node test/run-ui-test.mjs                 # launches VS Code against a fixture workspace; asserts panel + webview + RPC boot
```

See `chronos-vscode/TESTING.md` for the manual smoke checklist.

## Architecture — the big picture

### Two communication channels (this is the crux)

The extension host talks to the `pi` agent subprocess over **two distinct channels** — confusing them is the most common source of bugs:

1. **RPC (JSONL over stdin/stdout)** — extension → agent. `src/rpc/pi-rpc-session.ts` spawns `pi --mode rpc` and speaks a JSONL protocol (`src/rpc/rpc-types.ts`) for prompts, steering, state, model/command lists, session switching, and `extension_ui_request`/`extension_ui_response` (so the agent can pop VS Code dialogs). This is the control plane.
2. **HTTP** — agent → extension. On session start the host opens an HTTP server on a dynamic port and passes it via the `CHRONOS_HTTP_PORT` env var; the pi-package's `chronos/http/http-client.ts` POSTs viewer events (show page, text deltas, tool status) back. This is the one-way push channel for the viewer.

The webview never talks to either directly — it exchanges typed `postMessage` envelopes (`ExtToWebview` / `WebviewToExt` in `src/panel/webview-protocol.ts`) with the host, which bridges to RPC/HTTP. `src/panel/chronos-panel.ts` is the hub that owns the `PiRpcSession` and the webview.

### The webview (`chronos-vscode/webview/`)

Plain **Lit web components** (no React), bundled by esbuild to `out/webview/main.{js,css}`. Entry `main.ts`; root `components/chronos-app.ts` holds app state and forwards messages to `components/chronos-chat.ts` (transcript + composer) and `components/page-viewer.ts`. Styling is one CSS file (`styles.css`) driven by VS Code theme variables plus a `--ch-*` design system (bronze accent reserved for provenance/citations).

### The agent (`chronos/`)

`chronos/extensions/index.ts` is the pi-package entrypoint: it registers tools, the `/select-source` and `/yolo` commands, and lifecycle hooks. Tools live in `chronos/tools/` and share a mutable `SourceContext` (`tools/source-context.ts`) so `change_source` can redirect all source-bound tools at runtime. The system prompt is **rebuilt every turn** by the `before_agent_start` hook from `prompts/system-prompt.md` + the current `SourceContext` — it is never part of the persisted message history.

Key tools: `task`/`task_batch` (spawn persistent vision-expert subagents per page, follow-up-able via `task_id`; the expert runs a bounded tool loop and can `view_region`/`view_page` to self-zoom), `list_pages`, `show_page`/`show_text` (viewer), `change_source`. Expert models are any `provider/model-id` pi has auth for; no provider is hardcoded — they default to the orchestrator's current model.

### Important runtime facts

- **pi loads the agent from `dist/`, not the TS source.** The `pi` field points extensions at `./dist/extensions`. After editing anything under `chronos/{extensions,tools,utils,http}/*.ts` you MUST `cd chronos && npm run build` or the change won't take effect. Prompts and skills (`chronos/prompts/`, workspace `skills/`) are read live — no rebuild needed.
- **Which package pi runs is set in `~/.pi/agent/settings.json` `packages`.** Released use points at the GitHub repo (cloned under `~/.pi/agent/git/`). For local development, point that entry at the absolute path of the `chronos/` dir so sessions run your working copy (after building). Sessions snapshot at startup — restart the session to pick up agent changes.
- **pi packages were renamed.** `@mariozechner/pi-{coding-agent,ai}` are deprecated (frozen at 0.73.x); the maintained packages are `@earendil-works/pi-{coding-agent,ai}` (same author, a scope rename). Both the pi-package's peer deps and the installed `pi` binary now use `@earendil-works`. **Runtime pi ≠ build-time pi:** the build-time package in `chronos/node_modules` and the globally-installed `pi` binary can still drift in version — when debugging pi behavior, read the binary's actual install, not `chronos/node_modules`. The current API is pi 1.5 (`chronos-v2` pins `1.5.0`, see `piVersion` in its `package.json`; pi needs Node ≥ 22.19, Electron 45 ships 24.x), and it differs from 0.73. For example, the `session_switch`/`session_directory` hooks were dropped: `session_start` now carries a `reason`, and `PI_CODING_AGENT_SESSION_DIR` replaces the session-dir hook. Streaming changed in 0.84 and is unchanged since: an RPC `message_update` event carries an `assistantMessageEvent` delta (`text_start`/`text_delta`/`text_end`, likewise for thinking and tool calls, with a `contentIndex`; `toolcall_start` also carries `id` and `toolName`) plus cumulative `usage`, not the whole partial message. The client rebuilds the message between `message_start` and `message_end` (see `chronos-v2/src/renderer/stream-assembler.ts`). Since 0.99 a successful RPC `prompt` response carries `data.disposition` (`handled` for a slash command, `queued`, or `started`). Since 1.5 the extension loader aliases `@sinclair/typebox` to the `typebox` 1.x package it bundles and validates tool arguments with `@earendil-works/pi-schema` (plain JSON Schema semantics: `Type.Refine`, codecs and custom formats are ignored), and the root `@earendil-works/pi-ai` import resolves to an extension view that re-exports `/compat` plus `Type` — `chronos/utils/pi-ai-compat.ts` relies on that. `before_agent_start` (1.2) also fires for extension-triggered runs, so handlers must not assume `event.prompt` exists.
- **Every `.md` in `chronos/prompts/` becomes a slash command** because pi auto-registers prompt templates. Only `select-source` and `yolo` are real user commands; the rest are tool text / the system prompt. The webview slash-command menu therefore filters out `source: "prompt"` entries with `sourceInfo.origin === "package"` (see `chronos-panel.ts`).

### Workspace layout (user-facing, created by `Chronos: Init Workspace`)

A Chronos *workspace* (separate from this repo) contains `sources/<name>/png/page_NNNN.png`, `data/` (outputs), `memory/` (`MEMORY.MD` + per-source `.md`, injected into the system prompt), `skills/<name>/SKILL.md`, `sessions/`, and `.chronos/` (`.env` with provider API keys e.g. `ANTHROPIC_API_KEY`/`GEMINI_API_KEY`, written by the panel's "Log in" flow; `settings.json` for the `yolo` flag; `session-sources.json` mapping session id → selected source for resume; `session-names.json` caching auto-generated session titles). The workspace `skills/` dir is bridged into pi via `.pi/settings.json` (`{ "skills": ["../skills"] }`).

## chronos-v2/ (standalone Electron app)

```bash
cd chronos-v2 && npm install
npm run build                       # esbuild: main + preload + workers + renderer into out/
npm run dev -- --workspace <dir>    # build + launch straight into a workspace (dev pi + ../chronos)
npm run typecheck                   # tsc for main/preload/shared/test AND the renderer (two tsconfigs)
npm test                            # node:test unit/integration tests (test/*.test.ts, uses test/mock-pi.mjs)
npm run test:e2e                    # Playwright _electron boot test (test/e2e/); needs a prior build
npm run canary                      # real pinned pi + ../chronos agent: RPC contract check after a pi bump
npm run dist                        # bundle-agent (fills vendor/) + build + electron-builder installers
```

- **Main ↔ renderer** go through the preload bridge `window.chronos` (`postMessage`/`onMessage`/`getState`/`setState`) on one IPC channel, `chronos:msg`. The envelopes are the same typed `ExtToWebview`/`WebviewToExt` as before (`src/shared/webview-protocol.ts`). The renderer root is `chronos-app` (Lit).
- **Main process.** `src/main/main.ts` handles windows, menu, import and login. `AgentHost` (`agent-host.ts`) is the Electron-free port of `ChronosPanel`: it owns the `pi --mode rpc` subprocess (`rpc/pi-rpc-session.ts`) and the HTTP push server, the same two channels as the extension. `TreeHost` (`tree-host.ts`) serves the file tree and file open/save. `pi-launcher.ts` builds pi's argv/env (pi runs under Electron's binary with `ELECTRON_RUN_AS_NODE=1`, using `PI_CODING_AGENT_DIR` under userData and `PI_CODING_AGENT_SESSION_DIR` = `<workspace>/sessions`). `paths.ts` picks the vendored or dev pi/agent paths.
- **The `vendor/` rule.** `vendor/` is gitignored and used only when packaged. `npm run dist` (via `scripts/bundle-agent.mjs`) vendors the pinned pi and the *built* `../chronos` agent with production deps, and these ship as `resources/vendor/`. `npm run dev`/`npm start` use pi from `node_modules/@earendil-works/pi-coding-agent` and the agent from `../chronos`, so rebuild `chronos/` after agent changes. Never edit `vendor/`.
- **Workspace images** are served over the custom `chronos-file://local/<abs path>` protocol (`protocol-handler.ts`). It is scoped to the open workspace, never serves dot paths (`.chronos/.env`, `.pi/`, …), and anything else outside gets a 403. The renderer CSP allows images only from `chronos-file:` and `data:`.
- **Logs and windows.** `app-log.ts` writes `<app logs dir>/chronos.log` (previous run kept as `chronos.log.1`): console output of main plus pi's stderr lines, never pi's env. Help ▸ Show logs reveals it. pi is spawned without a shell on every platform (paths with spaces). On macOS, closing the last window keeps the app running and the dock icon reopens the welcome window; Linux/Windows quit. Every workspace open (welcome, menu, `--workspace`) goes through `openOrOfferInit` in `main.ts`, which offers to initialise a non-workspace folder.
- **Tests.** Unit and integration tests live in `test/*.test.ts` (node:test via tsx). `test/mock-pi.mjs` is a deterministic fake pi. The Electron e2e test is `test/e2e/boot.spec.ts`, configured by `playwright.config.ts`. It uses the test-only env flags `CHRONOS_PI_LAUNCH_OVERRIDE` (JSON `{bin,args,env?}` replacing the pi launch) and `CHRONOS_E2E=1` (exposes `window.__chronosTestState()` and main's `globalThis.__chronosE2E.agentPid()`). See `chronos-v2/README.md`.

## Reference

- `README.md` — install + getting-started (extension auto-installs `pi` and the pi-package on first run).
- `DOCS.md` — tool reference, SKILL.md format, memory system, bbox cropping.
- `chronos-vscode/TESTING.md` — test commands + manual smoke checklist.
- `chronos-v2/README.md` — standalone app: development, tests, env flags, building installers, releasing.
