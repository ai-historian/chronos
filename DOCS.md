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

Each expert keeps its own conversation (addressed by the `task_id` the tool returns), so you can ask follow-ups without re-sending the page image. These conversations are persisted per session under `.chronos/expert-sessions/`, so `task_id` follow-ups keep working after the agent restarts or a session is resumed. (Stored compactly — page images are re-read from disk on restore, not duplicated.)

### Bounding box cropping

`task` and `show_page` accept an optional `bbox` parameter with normalized coordinates (0–1):

```json
{ "x": 0.0, "y": 0.0, "w": 0.5, "h": 0.5 }
```

This crops the image before sending it to the vision model or displaying it in the viewer.

## Dataset output & the Data tab

The agent writes extraction results to `data/<source-name>/`. The Chronos panel has a **Data** tab (next to **Page**) that lists the files for the current source and renders them: a **JSON array of objects** becomes a sortable table, a single JSON object becomes a one-row table, and anything else (free-form text, CSV, partial JSON) is shown as text. The list refreshes when the agent finishes a turn; **Refresh** reloads the open file.

### Provenance keys

To make each row traceable to its source page, include any of these reserved keys in a row object. They are hidden from the table and rendered as a "view source" button. The Data and Page (source) viewers are independent: clicking "view source" shows a **zoomed view of the cited region** (the bbox plus a ~40% margin, not the whole page) in a **resizable preview panel docked at the bottom of the Data tab** — the region is outlined and the surrounding margin dimmed for context (~30% of the height by default, drag the divider to resize; it does not switch tabs). A **Show full page** button on that panel opens the full page in the Page viewer.

| Key | Type | Meaning |
|-----|------|---------|
| `chronos_page` | integer | Page the record was read from (same numbering as `show_page` / `[view p.N]`). |
| `chronos_bbox` | `[x, y, w, h]` (or `{x,y,w,h}`) | *Optional.* Region on that page, normalized 0–1. |
| `chronos_source` | string | *Optional.* Workspace-relative source path (e.g. `sources/Frankfurt_1864`) when the row is from a different source than the one in view. |

Example (`data/Frankfurt_1864/entries.json`):

```json
[
  { "surname": "Müller", "trade": "baker", "chronos_page": 42, "chronos_bbox": [0.10, 0.32, 0.80, 0.05] },
  { "surname": "Schmidt", "trade": "smith", "chronos_page": 42, "chronos_bbox": [0.10, 0.38, 0.80, 0.05] }
]
```

The keys are a recommendation — outputs without them still appear in the Data tab, just without click-to-source.

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

Run a skill by typing `/skill:extract-entries` in the chat.

## VS Code extension

### Commands

| Command | Description |
|---------|-------------|
| **Chronos: Init Workspace** | Scaffold workspace structure and set API key |
| **Chronos: Start Agent Session** | Launch the agent in the Chronos panel (page viewer + chat) |
| **Chronos: Show Page** | Open a specific page in the viewer |
| **Chronos: Import Sources** | Import selected file(s) or every supported file in a folder |
| **Chronos: Window Setup** | Configure VS Code layout for Chronos |

The agent emits clickable `[view p.N]` citations in the chat — click one to open that page (and any highlighted region) in the viewer.

### Architecture

The extension drives the pi agent as a subprocess and runs everything in one combined panel (page viewer + chat). It talks to the agent over two channels:

- **RPC (JSONL over stdin/stdout)** — extension → agent. The control plane: prompts, steering, session state, model/command lists, and the chat/tool event stream the agent sends back.
- **HTTP** — agent → extension. A one-way push channel for *viewer* events only. When a session starts the extension opens an HTTP server on a dynamic port and passes it via the `CHRONOS_HTTP_PORT` environment variable; the agent's viewer tools (`show_page`, `list_pages`, `show_text`, `change_source`) POST page-display events that the extension bridges into the panel's page viewer.

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
