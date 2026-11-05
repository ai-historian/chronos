# Chronos (standalone app)

Chronos v2 is a standalone Electron desktop app for the Chronos historian agent. It
doesn't need VS Code or a global `pi` install: the app bundles the `pi` runtime and the
Chronos agent (`../chronos`), and runs pi under Electron's own Node. A welcome window
opens or creates a workspace. The main window then shows a workspace file tree, a tabbed
center pane (page viewer, data viewer, text editors, images) and the agent chat.

## Development

Prerequisites: Node ≥ 22. Nothing else is needed: Electron, the pinned pi
(`@earendil-works/pi-coding-agent`, see `piVersion` in `package.json`) and Playwright are
devDependencies. In dev the app loads the agent from the sibling `../chronos` checkout, so
build that once (`cd ../chronos && npm install && npm run build`) and again after you
change it.

```bash
npm install
npm run dev -- --workspace <dir>   # build, then launch Electron straight into a workspace
npm run dev                        # no --workspace: start at the welcome window
npm run watch                      # rebuild out/ on change (reload the window to pick it up)
npm run typecheck                  # tsc for main/preload/shared/tests and for the renderer
```

### Tests

```bash
npm test           # builds, then runs the node:test unit/integration tests in test/*.test.ts
npm run test:e2e   # Playwright _electron boot test (test/e2e/); run `npm run build` first
npm run canary     # spawns the REAL pinned pi + ../chronos agent; run after bumping pi
```

`test/mock-pi.mjs` is a deterministic fake `pi --mode rpc` (it speaks the JSONL contract
and POSTs `show_page` over HTTP). The integration tests and the e2e suite drive the app
with it. The e2e suite launches `out/main.js` against a temp workspace and checks the
three panes, agent boot, `show_page` through `chronos-file://`, streamed text, pending UI
requests being cleared when the agent dies, that no CSP or resource-load errors occur,
and an editor round trip. Playwright uses Electron directly, so no browser download is
needed. On a headless Linux box, run it under `xvfb-run`.

### Layout of `src/`

- `main/` — Electron main process. `main.ts` handles windows, menu, import and login
  wiring. `agent-host.ts` owns the `pi --mode rpc` subprocess
  (`rpc/pi-rpc-session.ts`, JSONL over stdio) and the loopback HTTP server
  (`http-server.ts`) that the agent POSTs viewer events to. `pi-launcher.ts` builds pi's
  argv/env and `paths.ts` resolves vendored vs dev pi/agent paths. `tree-host.ts` and
  `files.ts` back the file tree and file actions. `protocol-handler.ts` serves the
  `chronos-file://local/<path>` scheme, scoped to the open workspace (never dot paths). `import/` is the
  PDF/image/text import pipeline and its workers. `login.ts` and `anthropic-oauth.ts`
  handle provider login. `app-log.ts` writes the app log. `menu.ts`, `theme.ts`, `workspace.ts`, `sessions.ts` and
  `sources.ts` cover the rest.
- `preload/preload.ts` — exposes `window.chronos` (`postMessage`, `onMessage`,
  `getState`/`setState`, `isE2E`) over the `chronos:msg` IPC channel.
- `renderer/` — Lit web components (`components/chronos-app.ts` is the root) plus pure
  models (`tree-model`, `tabs-model`, `stream-assembler`, `save-queue`). `welcome.*` is
  the welcome window.
- `shared/webview-protocol.ts` — the typed `ExtToWebview` / `WebviewToExt` envelopes
  exchanged between main and renderer.

### Logs and window behaviour

The main process writes `chronos.log` into Electron's logs folder (`app.getPath("logs")`,
e.g. `~/Library/Logs/Chronos` on macOS, `%APPDATA%\Chronos\logs` on Windows,
`~/.config/Chronos/logs` on Linux). It holds main's `console` output and pi's stderr, never
pi's environment (API keys). Each start rotates the previous log to `chronos.log.1`.
Help ▸ Show logs reveals the file.

On macOS, closing the last window keeps Chronos running in the dock, and clicking the dock
icon opens the welcome window. On Linux and Windows the app quits with its last window.

### The `vendor/` rule

`vendor/` (gitignored) is only for packaged builds. `npm run dist` runs `bundle-agent`,
which copies the pinned pi runtime and the built `../chronos` agent into `vendor/`, and
electron-builder ships them as `resources/vendor/`. `npm run dev` / `npm start` never read
`vendor/`. They run pi from `node_modules/@earendil-works/pi-coding-agent` and the agent
from `../chronos` (see `src/main/paths.ts`). Don't edit files in `vendor/`, and don't
point dev at it.

### Environment flags

| Variable | Effect |
|---|---|
| `CHRONOS_PI_LAUNCH_OVERRIDE` | **Test-only.** JSON `{ "bin", "args", "env"? }` that replaces the pi launch. `CHRONOS_HTTP_PORT` is merged into `env`. The e2e suite uses it to run `test/mock-pi.mjs`. |
| `CHRONOS_E2E=1` | **Test-only.** Enables the e2e seams: `window.chronos.isE2E()`, `window.__chronosTestState()` in the renderer, and `globalThis.__chronosE2E.agentPid()` in main. |
| `CHRONOS_DEV_PROTOCOL_CHECK=1` | Dev aid: on load, loads an in-workspace PNG (`sources/Demo/png/page_0001.png`) and an outside file through `chronos-file://`, and logs loaded/blocked. |
| `CHRONOS_DEV_MENU_DUMP=1` | Dev aid: logs the application menu's top-level items each time it is rebuilt. |

## Building installers

Prerequisites: Node 22+, and the sibling `../chronos` agent checkout (the bundler builds it).
Installers are built per OS on that OS — there is no cross-compilation.

```bash
npm ci
npm run dist            # = bundle-agent + build + electron-builder (targets for the current OS)
npm run dist -- --linux AppImage deb   # pick targets explicitly
```

- `npm run bundle-agent` fills the gitignored `vendor/` with the pi runtime and the built
  `../chronos` agent (production `node_modules`), and refreshes `resources/licenses/`.
- `npm run build` bundles the app into `out/` with esbuild.
- `electron-builder` (config in `electron-builder.yml`) writes the artefacts to `dist/`:
  `Chronos-<version>.AppImage` and `chronos_<version>_amd64.deb` on Linux,
  `Chronos-<version>-arm64.dmg` / `Chronos-<version>-x64.dmg` on macOS (`--mac --arm64` or
  `--mac --x64`, matching the build machine), an NSIS `Setup .exe` on Windows. `vendor/`
  and the licences ship under the app's `resources/`, outside the asar; the PDF import
  workers and `mupdf` are unpacked to `app.asar.unpacked/`.

**Native modules are per platform.** `vendor/chronos/node_modules` contains `sharp` with
the `@img/*` prebuilds for the machine that ran `bundle-agent`, so build each OS's
installer on that OS. The same holds per CPU architecture: there is no universal macOS
build. CI builds the arm64 dmg on `macos-latest` and the x64 dmg on `macos-15-intel`; the
x64 leg depends on GitHub still offering an Intel macOS runner label. `bundle-agent` has
no target-platform switch yet.

**Releasing** (`.github/workflows/v2-release.yml`):

1. Set `version` in `chronos-v2/package.json`, commit, and push a tag `v2-<version>`
   (e.g. `v2-0.3.0`). The workflow fails if the tag and the version differ.
2. The workflow creates one draft GitHub release for that tag, then builds the Linux,
   Windows, macOS arm64 and macOS x64 installers in parallel and uploads them all into
   that draft (electron-builder `publish`: `tagNamePrefix: "v2-"`, `releaseType: draft`).
   The `v2-` prefix keeps these releases apart from the VS Code extension's `v<version>`
   tags.
3. Check the draft's artefacts and publish it manually on GitHub.

A manual `workflow_dispatch` run builds every installer with `--publish never` and
releases nothing.

**Signing** is electron-builder's default: it signs only when `CSC_LINK` (certificate
file/base64) and `CSC_KEY_PASSWORD` are set; otherwise builds are unsigned. macOS
notarization is off.
