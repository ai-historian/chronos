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
    └── .env                  # provider API keys (e.g. ANTHROPIC_API_KEY, GEMINI_API_KEY)
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
`provider/model-id`. If you omit it, they default to the model selected in the panel
header (the orchestrator's current model) — no provider is hardcoded. Examples:

- `anthropic/claude-opus-4-8`
- `google/gemini-3-flash-preview`
- `google/gemini-3.1-pro-preview`
- `openai/gpt-...`

The model must be vision-capable when a page image is attached. An unknown model name
errors with the list of available models.

**Choosing a model** (recommendation, not a requirement): a fast/cheap vision model such
as `google/gemini-3-flash-preview` is a good default for routine pages; reach for a
stronger one (e.g. `google/gemini-3.1-pro-preview` or `anthropic/claude-opus-4-8`) on
dense tables, marginalia, or faint/damaged ink. Experts can also zoom in themselves (see
`view_region` / `view_page` below), which often matters more than raw model size.

Each expert keeps its own conversation (addressed by the `task_id` the tool returns), so you can ask follow-ups without re-sending the page image. These conversations are persisted per session under `.chronos/expert-sessions/`, so `task_id` follow-ups keep working after the agent restarts or a session is resumed. (Stored compactly — page images, including any tool-driven zoom crops, are re-read from disk on restore, not duplicated.)

#### Expert self-direction

Experts aren't limited to the single (optionally pre-cropped) image the orchestrator hands them — they run a bounded agentic loop (capped at 8 tool calls/turn). **By default they are read-only:**

- **`view_region(bbox, [page_id])`** — crop a region of a page at full resolution (dense table, marginal note, faint ink). Omits `page_id` to zoom into the page in view.
- **`view_page(page_id)`** — load another full page from the same source.
- **`read_file(path)`** / **`list_dir([path])`** / **`grep(pattern, [path])`** — read and search the workspace (schemas, memory, prior outputs). Scoped to the workspace root.

So you don't have to predict the right crop up front — pass the page and let the expert zoom and cross-reference where it needs to.

#### Granting elevated capabilities (off by default)

Experts **cannot run commands or change files** unless the orchestrator passes `grant` on the `task`/`task_batch` call:

- `grant: ["bash"]` — `bash(command)` (runs in the workspace dir)
- `grant: ["write"]` — `write_file(path, content)`
- `grant: ["edit"]` — `edit_file(path, old_text, new_text)`

This path is deliberately gated for oversight and safety: requesting a grant triggers a **user confirmation** before any expert runs (once per `task` call, or once for a whole `task_batch` cohort), and denial aborts the call. Granted file operations are confined to the workspace. Whatever the expert does — every region viewed, file read/written, command run — is surfaced in the expert drawer (the "examined" steps; region/page steps are clickable, elevated actions are flagged), so the work stays auditable. Leave `grant` off unless a task genuinely needs the expert to act on its own.

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
| `chronos_page` | integer **or list** | Page the record was read from (same numbering as `show_page` / `[view p.N]`). |
| `chronos_bbox` | `[x, y, w, h]` / `{x,y,w,h}` **or list** | *Optional.* Region on that page, normalized 0–1. |
| `chronos_source` | string **or list** | *Optional.* Workspace-relative source path (e.g. `sources/Frankfurt_1864`) when the row is from a different source than the one in view. |

Example (`data/Frankfurt_1864/entries.json`):

```json
[
  { "surname": "Müller", "trade": "baker", "chronos_page": 42, "chronos_bbox": [0.10, 0.32, 0.80, 0.05] },
  { "surname": "Schmidt", "trade": "smith", "chronos_page": 42, "chronos_bbox": [0.10, 0.38, 0.80, 0.05] }
]
```

#### Multiple references per row

A row can cite **more than one** source location — a value split across two pages, a figure assembled from several regions, or a fact corroborated by a marginal note. Pass the reserved keys as **parallel lists** and the Data tab renders one citation chip per reference, each linking to its own page/region:

```json
[
  {
    "name": "Anna Weber",
    "chronos_page": [42, 43],
    "chronos_bbox": [[0.10, 0.90, 0.80, 0.06], [0.10, 0.04, 0.80, 0.06]]
  },
  {
    "name": "Karl Vogt",
    "chronos_page": 42,
    "chronos_bbox": [[0.10, 0.32, 0.80, 0.05], [0.55, 0.32, 0.40, 0.05]]
  }
]
```

The lists align by index. A scalar is treated as a single-element list (so existing single-reference outputs are unchanged), and a length-1 list **broadcasts** — e.g. one `chronos_source` shared across several pages, or several `chronos_bbox` regions on a single `chronos_page` (the second row above). A reference must resolve to a page id.

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
