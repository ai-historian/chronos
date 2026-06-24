# How it works

<p class="lead" markdown="span">A look under the hood: the two-package design, the two channels between the
extension and the agent, and the decisions that shape how Chronos behaves.</p>

## Two packages

Chronos is two independently-built npm packages:

- **`chronos/`** — a [pi](https://github.com/badlogic/pi-mono) *pi-package*: the agent itself (custom tools, prompts, lifecycle hooks). It isn't a standalone program — it loads into your globally-installed `pi` agent at runtime.
- **`chronos-vscode/`** — the VS&nbsp;Code extension: a host process plus a Lit web-component UI (the viewer + chat) that drives a `pi` subprocess.

The extension launches `pi` as a subprocess in `--mode rpc`. pi loads the agent from compiled JavaScript in
`dist/`, which is why developing the agent means rebuilding it.

## Two channels (the crux)

The host talks to the agent over **two distinct channels pointing in opposite directions** — and the
webview talks to neither directly.

<div class="coord-fig">
<svg viewBox="0 0 620 270" role="img" aria-label="The extension host talks to the pi agent over two channels: RPC for control, HTTP for viewer events; the webview bridges through the host.">
  <rect x="20" y="20" width="160" height="70" rx="10" fill="#f8f4ec" stroke="#b9772d" stroke-width="1.5"/>
  <text x="100" y="50" text-anchor="middle" font-family="Schibsted Grotesk,sans-serif" font-size="14" font-weight="650" fill="#211a12">Webview (Lit UI)</text>
  <text x="100" y="70" text-anchor="middle" font-family="ui-monospace,monospace" font-size="10" fill="#897b65">viewer + chat</text>
  <rect x="230" y="20" width="160" height="230" rx="10" fill="#f8f4ec" stroke="#5a4e3d" stroke-width="1.5"/>
  <text x="310" y="48" text-anchor="middle" font-family="Schibsted Grotesk,sans-serif" font-size="14" font-weight="650" fill="#211a12">Extension host</text>
  <text x="310" y="66" text-anchor="middle" font-family="ui-monospace,monospace" font-size="9.5" fill="#897b65">chronos-panel.ts</text>
  <rect x="440" y="20" width="160" height="230" rx="10" fill="#f8f4ec" stroke="#36607e" stroke-width="1.5"/>
  <text x="520" y="48" text-anchor="middle" font-family="Schibsted Grotesk,sans-serif" font-size="14" font-weight="650" fill="#211a12">pi agent</text>
  <text x="520" y="66" text-anchor="middle" font-family="ui-monospace,monospace" font-size="9.5" fill="#897b65">chronos pi-package</text>
  <text x="520" y="80" text-anchor="middle" font-family="ui-monospace,monospace" font-size="9" fill="#897b65">(subprocess)</text>
  <line x1="180" y1="55" x2="230" y2="55" stroke="#b9772d" stroke-width="2"/>
  <polygon points="230,55 222,51 222,59" fill="#b9772d"/><polygon points="180,55 188,51 188,59" fill="#b9772d"/>
  <text x="205" y="42" text-anchor="middle" font-family="ui-monospace,monospace" font-size="8.5" fill="#8a5316">postMessage</text>
  <line x1="390" y1="120" x2="440" y2="120" stroke="#36607e" stroke-width="2"/>
  <polygon points="440,120 432,116 432,124" fill="#36607e"/>
  <text x="415" y="110" text-anchor="middle" font-family="ui-monospace,monospace" font-size="9" fill="#36607e">RPC</text>
  <text x="415" y="137" text-anchor="middle" font-family="ui-monospace,monospace" font-size="7.5" fill="#897b65">control →</text>
  <line x1="440" y1="190" x2="390" y2="190" stroke="#3f7d4f" stroke-width="2"/>
  <polygon points="390,190 398,186 398,194" fill="#3f7d4f"/>
  <text x="415" y="180" text-anchor="middle" font-family="ui-monospace,monospace" font-size="9" fill="#3f7d4f">HTTP</text>
  <text x="415" y="207" text-anchor="middle" font-family="ui-monospace,monospace" font-size="7.5" fill="#897b65">← viewer push</text>
  <text x="310" y="240" text-anchor="middle" font-family="ui-monospace,monospace" font-size="8.5" fill="#897b65">owns both ends</text>
</svg>
</div>

- **RPC** — a JSONL protocol over the subprocess's stdin/stdout, *extension → agent*. This is the control plane: prompts, steering, abort, session state, model and command lists, session switching, and the chat/tool event stream the agent sends back. It also lets the agent pop VS&nbsp;Code dialogs (the human-gated confirmations).
- **HTTP** — a one-way push channel, *agent → extension*, for viewer events only (show page, page list, show text). On session start the host opens a loopback HTTP server on a dynamically-assigned port and hands it to the agent via the `CHRONOS_HTTP_PORT` environment variable. If that's missing the agent still runs — the viewer just goes quiet.

The webview exchanges typed `postMessage` envelopes with the host, which bridges them to RPC and HTTP.
`chronos-panel.ts` is the hub that owns the agent session and the webview.

## A system prompt rebuilt every turn

Chronos's system prompt isn't a fixed string baked into the conversation. The `before_agent_start` hook
rebuilds it **every turn** from a template plus the live source context and the current memory files. It's
never part of the persisted message history. That's why switching source or editing a memory file takes
effect on the very next turn, with nothing stale lingering in the transcript — and why the active source is
tracked out-of-band, never written into the conversation.

## Why it's built this way

<div class="feature-grid">
  <div class="feature"><h3>Built on pi</h3><p>Reusing the pi agent runtime means model routing, sessions, compaction, and tool plumbing are solved — Chronos adds only the document-analysis tools, prompts, and viewer.</p></div>
  <div class="feature"><h3>Read-only experts, gated power</h3><p>Experts can inspect freely but can't run commands or edit files without an explicit grant and a confirmation — oversight is the default, not an afterthought.</p></div>
  <div class="feature"><h3>Provenance first-class</h3><p>The reserved keys and click-to-source preview make “show me where this came from” a one-click action, which is what historical work demands.</p></div>
  <div class="feature"><h3>Provider-agnostic</h3><p>No provider is hard-coded; pick any vision model your key covers, per task — balancing cost and accuracy page by page.</p></div>
  <div class="feature"><h3>Crash-safe by construction</h3><p>Imports stage into a partial folder and rename atomically, so an interrupted conversion is resumable, never half-written.</p></div>
  <div class="feature"><h3>Shared, mutable source context</h3><p>One object every source-bound tool reads, so switching sources redirects them all instantly without rebuilding the session.</p></div>
</div>

## Building it yourself

```bash title="build"
# the pi-package (agent) — compiles TypeScript to dist/, which pi loads
cd chronos && npm run build

# the VS Code extension — esbuild bundles the host + webview into out/
cd chronos-vscode && npm run build       # one-shot
cd chronos-vscode && npm run package     # -> .vsix
```

Prompts (under `chronos/prompts/`) and workspace skills are read live — no rebuild needed. Only changes to
the agent's TypeScript require `npm run build`. See the repository's `CLAUDE.md` and `DOCS.md` for the full
developer reference.
