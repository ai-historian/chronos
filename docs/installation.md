# Installation

<p class="lead" markdown="span">Install one VS&nbsp;Code extension. On first run it bootstraps everything else it
needs and walks you through connecting an AI provider.</p>

## Prerequisites

| Requirement | Why |
|---|---|
| [VS&nbsp;Code](https://code.visualstudio.com/) `1.110` or newer | Chronos ships as a VS&nbsp;Code extension. |
| [Node.js](https://nodejs.org/) `18` or newer | Required by `pi`, the agent runtime the extension installs for you. |
| An AI provider | A vision-capable model. Use a Claude Pro/Max subscription or an API key from any supported provider — you connect it inside the panel, so none is needed to install. |

## Install the extension

Install **Chronos — The AI Historian** from inside VS&nbsp;Code:

<ol class="steps">
  <li><strong>Open the Extensions view</strong><p>Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> on macOS).</p></li>
  <li><strong>Search for <em>Chronos — The AI Historian</em></strong><p>The publisher is <code>AI-Historian</code> (full id <code>AI-Historian.chronos-ai-historian</code>).</p></li>
  <li><strong>Click Install</strong><p>That is the only manual install step.</p></li>
</ol>

## First-run bootstrap

The extension does *not* bundle the agent. The first time you run a Chronos command it checks for two
dependencies and offers to install them in a VS&nbsp;Code terminal — no manual `npm` needed. It detects
`pi` by actually running `pi --version`, then installs:

- the **pi agent runtime** — `npm install -g @earendil-works/pi-coding-agent`
- the **Chronos pi-package** — `pi install https://github.com/ai-historian/chronos@v0.2.1` (pinned to the extension's version tag)

```bash title="first-run install (run for you in a terminal)"
npm install -g @earendil-works/pi-coding-agent && pi install https://github.com/ai-historian/chronos@v0.2.1
```

On a brand-new machine without `pi`, a four-step **Get Started with Chronos** walkthrough opens once —
install dependencies, initialise a workspace, start a session, connect a provider. Its checkmarks
reflect real state, so they tick as you complete each step.

!!! tip "If it didn't take"
    If a command reports that dependencies are missing, run **Chronos: Install Dependencies (pi + agent)**
    from the Command Palette (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>) to retry. The install runs as a
    visible terminal task, so its output and any errors are right there.

## Manual install (advanced / offline)

```bash title="manual install"
# 1. Install the pi agent runtime globally
npm install -g @earendil-works/pi-coding-agent

# 2. Register the Chronos pi-package
pi install https://github.com/ai-historian/chronos

# 3. Install the VS Code extension from a downloaded .vsix
code --install-extension chronos-ai-historian-0.2.1.vsix
```

The `.vsix` is published on [GitHub Releases](https://github.com/ai-historian/chronos/releases).

## Connect an AI provider

Start a session (**Chronos: Start Agent Session**) and the panel opens. Until you connect a provider, no
models are available and a banner prompts you to log in. Click **Log in** in the header (or run
**Chronos: Connect AI Provider (Log In)**) and choose one of two paths:

| Path | How it works | Stored in |
|---|---|---|
| **Claude Pro / Max** (subscription) | Signs in with your Claude subscription via OAuth in the browser — no API key. Opens `claude.ai`, captures the redirect, exchanges a token. | `~/.pi/agent/auth.json` |
| **API key** (any provider) | Paste a key for Anthropic, Google, OpenAI, OpenRouter, xAI, Groq, Mistral, or DeepSeek — or any other provider via a custom variable name. | `.chronos/.env` in the workspace |

Either way Chronos reconnects automatically, and you can switch or add providers the same way at any
time. The `.chronos/.env` file uses the standard per-provider variable names:

```bash title=".chronos/.env"
ANTHROPIC_API_KEY=...      # Claude
GEMINI_API_KEY=...         # Google Gemini
OPENAI_API_KEY=...         # OpenAI
# OPENROUTER_API_KEY, XAI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, DEEPSEEK_API_KEY …
```

!!! note
    The subscription path writes an OAuth credential to pi's `auth.json`, not to `.chronos/.env`.
    Model choice is per-task and provider-agnostic — see [choosing a model](experts.md#choosing-a-model).

## The commands you'll use

| Command | What it does |
|---|---|
| **Chronos: Init Workspace** | Scaffolds the workspace folders in the current folder. |
| **Chronos: Import Sources** | Imports files or a whole folder; converts PDFs to page images. |
| **Chronos: Start Agent Session** | Opens the Chronos panel (viewer + chat) and launches the agent. |
| **Chronos: Connect AI Provider (Log In)** | Connects or switches a provider. |
| **Chronos: Show Page** | Opens a specific page in the viewer. |
| **Chronos: Install Dependencies (pi + agent)** | Re-runs the bootstrap. |
| **Chronos: Window Setup** | Arranges the VS Code layout for Chronos. |
