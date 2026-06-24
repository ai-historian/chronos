# Reference

<p class="lead" markdown="span">Commands, slash commands, workspace files, provider variables, and a
troubleshooting checklist — the quick-lookup page.</p>

## VS Code commands

Open the Command Palette with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> and type "Chronos".

| Command | Does |
|---|---|
| **Chronos: Init Workspace** | Scaffold the workspace structure in the current folder. |
| **Chronos: Import Sources** | Import file(s) or a whole folder; convert PDFs to page images. |
| **Chronos: Start Agent Session** | Open the Chronos panel and launch the agent. |
| **Chronos: Connect AI Provider (Log In)** | Connect or switch an AI provider. |
| **Chronos: Show Page** | Open a specific page in the viewer. |
| **Chronos: Install Dependencies (pi + agent)** | Re-run the first-run bootstrap. |
| **Chronos: Window Setup** | Arrange the VS Code layout for Chronos. |

## Slash commands

| Command | Does |
|---|---|
| `/select-source [name]` | Pick a source — a picker with no argument, or by name directly. |
| `/yolo` | Toggle auto-approve (skip bash confirmations) for the workspace. Same as the header's Auto-approve. |
| `/skill:<name>` | Run a skill from `skills/<name>/SKILL.md`. |

The slash menu also lists your skills. Chronos's internal prompt templates are auto-registered by pi but
hidden from the menu — only the commands above and your skills are user-facing.

## Workspace files

| Path | Role |
|---|---|
| `sources/<name>/png/page_NNNN.png` | Imported page images, one folder per source. |
| `data/<name>/` | Extraction outputs (created when the agent first writes). |
| `memory/MEMORY.MD` | Global cross-source memory. |
| `memory/<name>.md` | Per-source memory. |
| `skills/<name>/SKILL.md` | Your reusable task definitions. |
| `sessions/` | Conversation history (resumable from the History drawer). |
| `.pi/settings.json` | Bridges `skills/` into pi. |
| `.chronos/.env` | Provider API keys. |
| `.chronos/settings.json` | Workspace settings (e.g. the `yolo` flag, the bash allowlist). |
| `.chronos/session-sources.json` | Maps each session to its selected source (so resume restores it). |

## Provider variables

API-key login writes these to `.chronos/.env`; you can also edit the file directly.

| Provider | Variable |
|---|---|
| Anthropic (Claude) | `ANTHROPIC_API_KEY` |
| Google (Gemini) | `GEMINI_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| xAI (Grok) | `XAI_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |

The Claude Pro/Max subscription login instead writes an OAuth credential to `~/.pi/agent/auth.json`.

## pi CLI options

The underlying `pi` binary supports many options; useful ones:

```bash title="pi"
pi --model anthropic/claude-opus-4-8   # use a specific model
pi -c                                   # continue the previous session
pi -r                                   # resume a chosen session
pi --help                               # full list
```

## Provenance keys (quick reference)

| Key | Type | Notes |
|---|---|---|
| `chronos_page` | int or list | File-system page index (`1` = `page_0001.png`). Required for a citation. |
| `chronos_bbox` | `{x,y,w,h}` / `[x,y,w,h]` or list | Normalized 0–1, origin top-left. Optional. |
| `chronos_source` | string or list | Workspace-relative source path. Optional. |

Full explanation: [Provenance &amp; bounding boxes](provenance.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| "No AI models available" | Click **Log in** and connect a provider — see [connect a provider](installation.md#connect-an-ai-provider). |
| A command says dependencies are missing | Run **Chronos: Install Dependencies (pi + agent)**; watch the terminal it opens for errors. |
| `pi` installed but not detected | GUI-launched VS Code may not see your shell's PATH. Reinstall via the command above, or set `chronos.piPath` in settings. |
| A skill doesn't appear in the `/` menu | Check the `SKILL.md` has a non-empty `description` and a slug `name`; reload the window. |
| A citation chip doesn't open | Confirm the row's `chronos_page` is the file-system index, and that the page file exists. |
| A large PDF won't import | Files over 2&nbsp;GiB split automatically; if one still fails, [open an issue](https://github.com/ai-historian/chronos/issues). |
