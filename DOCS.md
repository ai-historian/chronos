# Chronos — Technical Documentation

## Workspace structure

```
<workspace>/
├── sources/                  # Scanned page images
│   └── <source-name>/
│       └── png/
│           ├── page_0001.png
│           └── ...
├── data/                     # Outputs
│   └── <source-name>/       # Per-source extractions, summaries, JSON
├── skills/                   # Custom task definitions
│   └── <skill-name>/
│       └── SKILL.md          # Task instructions
├── memory/                   # Persistent memory
│   ├── MEMORY.MD             # Cross-source insights
│   └── <source-name>.md     # Per-source findings
├── sessions/                 # Conversation history (auto-generated)
└── .chronos/
    └── .env                  # GEMINI_API_KEY
```

## Tools

The agent has these built-in tools for working with sources:

| Tool | Description |
|------|-------------|
| `list_pages` | List available page IDs in the current source |
| `task` | Talk to an expert model in a persistent conversation. Omitting `task_id` spawns a new expert and returns its id; passing it back asks follow-up questions in the same conversation. Optionally attaches a page image (with bounding-box cropping) and supports per-task model selection |
| `show_page` | Display a page in the viewer without analysis. Supports bounding box cropping |
| `show_text` | Display a text file in the viewer with optional passage highlighting |
| `task_batch` | Batch version of `task` — spawns one persistent expert per page (each follow-up-able via `task`); requires explicit user confirmation |
| `change_source` | Switch to a different source at runtime |

Standard file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) are also available for working with output files.

### Expert models

The `task` and `task_batch` tools accept any model pi has configured auth for, as
`provider/model-id` (default: `google/gemini-3-flash-preview`), e.g.:

- `google/gemini-3-flash-preview`
- `google/gemini-3.1-pro-preview`
- `anthropic/claude-opus-4-8`

An unknown model name errors with the list of available models.

### Bounding box cropping

`task` and `show_page` accept an optional `bbox` parameter with normalized coordinates (0–1):

```json
{ "x": 0.0, "y": 0.0, "w": 0.5, "h": 0.5 }
```

This crops the image before sending it to the vision model or displaying it in the viewer.

## Skills

Skills are self-contained task definitions that tell the agent what to do. They live in `skills/<skill-name>/`.

### SKILL.md format

```yaml
---
name: Extract Business Entries
description: Extract business names, addresses, and trades from directory pages
requires: schema.json
---

# Instructions for the agent

Analyze each page and extract all business entries...
```

- `name` — human-readable name shown in the UI
- `description` — one-line summary
- `requires` — comma-separated filenames that must exist in the source directory (leave blank if none)

Run a skill by typing `/skill:extract-entries` in the pi terminal.

## VS Code extension

### Commands

| Command | Description |
|---------|-------------|
| **Chronos: Init Workspace** | Scaffold workspace structure and set API key |
| **Chronos: Start Agent Session** | Launch the agent in a terminal with page viewer |
| **Chronos: Show Page** | Open a specific page in the viewer |
| **Chronos: Import Sources** | Batch-import files from a folder |
| **Chronos: Window Setup** | Configure VS Code layout for Chronos |

The extension provides clickable `[view p.N]` links in the terminal — click to open any page in the viewer.

### Architecture

The VS Code extension communicates with the pi agent over HTTP. When a session starts, the extension spins up an HTTP server on a dynamic port and passes it to the agent via the `CHRONOS_HTTP_PORT` environment variable. The agent sends messages (page display, text updates, tool status) to the extension via HTTP POST.

## Memory system

The agent maintains persistent memory across sessions:

- **Global memory** (`memory/MEMORY.MD`) — cross-source insights, recurring conventions, abbreviation patterns, lessons learned
- **Per-source memory** (`memory/<source-name>.md`) — document-specific findings like page ranges, section boundaries, layout observations, and structural notes

Memory files survive session restarts and are loaded automatically when the agent starts or switches sources.

## Development

```bash
# Build the pi package
cd chronos && npm run build

# Build the VS Code extension
cd chronos-vscode && npm run build

# Package the VS Code extension
cd chronos-vscode && npm run package
```
