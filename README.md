# Chronos

AI-powered agent for digitizing historical German city directories. Chronos combines a document analysis agent with a VS Code extension to analyze scanned page images, extract structured data, and build knowledge about archival sources.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [VS Code](https://code.visualstudio.com/) (v1.110+)
- A [Gemini API key](https://aistudio.google.com/apikey) for the vision model
- `mutool` (from [MuPDF](https://mupdf.com/)) if importing PDFs

## Installation

### 1. Install the CLI

From the project root:

```bash
npm install
npm run build
npm install -g .
```

Or install the pre-built tarball:

```bash
npm install -g release/chronos-1.0.0.tgz
```

This makes the `chronos` command available globally.

### 2. Install the VS Code extension

```bash
code --install-extension release/chronos-0.1.0.vsix
```

## Getting started

### Initialize a workspace

Open VS Code in an empty folder and run the command **Chronos: Init Workspace** from the command palette (`Ctrl+Shift+P`). This creates the workspace structure and prompts for your Gemini API key.

Alternatively, from the CLI:

```bash
mkdir my-workspace && cd my-workspace
chronos --source <path-to-source> --workspace .
```

The workspace will be scaffolded automatically on first run.

### Import sources

Sources are directories containing scanned page images. You can import them through VS Code or place them manually.

**Via VS Code:** Run **Chronos: Import Sources** and select a folder. Supported formats:

- **PDF** — converted to PNGs at 200 DPI via `mutool` (one page per file)
- **Images** (PNG, JPG, TIFF, BMP) — copied into the source's `png/` directory
- **Text files** — copied to the source root

**Manually:** Create a directory under `sources/` with a `png/` subdirectory containing page images named `page_NNNN.png` (or `.jpg`/`.jpeg`):

```
sources/my-directory/
  png/
    page_0001.png
    page_0002.png
    ...
```

### Run the agent

**From VS Code:** Run **Chronos: Start Agent Session**, pick a source, and interact with the agent in the integrated terminal. The page viewer opens automatically.

**From the CLI:**

```bash
# Interactive mode
chronos --source sources/my-directory --workspace .

# Run a specific skill
chronos --source sources/my-directory --workspace . --task extract-entries

# Specify a model
chronos --source sources/my-directory --workspace . --model gemini-2.5-pro
```

**As a web server (multi-session):**

```bash
npm run web -- --workspace . --port 3000
```

Then open `http://localhost:3000` in a browser. The web UI supports multiple concurrent sessions via WebSocket.

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
│       ├── SKILL.md          # Task instructions (required)
│       └── index.ts          # Custom tools (optional)
├── memory/                   # Persistent memory
│   ├── MEMORY.md             # Long-term curated notes
│   ├── YYYY-MM-DD.md         # Daily session logs
│   └── <source-name>.md     # Per-source findings
├── sessions/                 # Conversation history (auto-generated)
│   ├── <id>.jsonl
│   ├── <id>.meta.json
│   └── <id>.enrichment.json
└── .chronos/                 # Agent identity & config
    ├── SOUL.md               # Agent personality
    ├── AGENTS.md             # Workspace conventions
    └── .env                  # GEMINI_API_KEY
```

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

### Custom tools (optional)

Create an `index.ts` alongside `SKILL.md` to register custom tools:

```typescript
import { Type } from "@sinclair/typebox";

export function createTools(ctx) {
  return [
    {
      name: "validate_entry",
      label: "Validate Entry",
      description: "Check an extracted entry against known records",
      parameters: Type.Object({
        name: Type.String({ description: "Business name" }),
      }),
      async execute(_toolCallId, params) {
        // Custom logic here
        return {
          content: [{ type: "text", text: "Valid" }],
          details: {},
        };
      },
    },
  ];
}
```

Run a skill with `--task <skill-name>` from the CLI, or select it when starting a session in VS Code/web UI.

## Core tools

The agent has these built-in tools for working with sources:

| Tool | Description |
|------|-------------|
| `list_pages` | List available page IDs in the current source |
| `analyze_page` | Send a page image to the vision model with a prompt |
| `follow_up_question` | Continue the conversation about the last analyzed page (avoids re-sending the image) |
| `show_page` | Display a page in the viewer without analysis |
| `show_text` | Display a text file in the viewer |
| `ask_pages_batch` | Batch-process multiple pages (requires explicit user confirmation) |
| `change_source` | Switch to a different source at runtime |

Standard file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) are also available for working with output files.

## Architecture

```
┌────────────────────────────────────────────────────┐
│                  User Interfaces                    │
│  ┌──────────────┬──────────────┬────────────────┐  │
│  │  VS Code     │  Web UI      │  CLI (TUI)     │  │
│  │  Extension   │  Express+WS  │  Interactive   │  │
│  └──────┬───────┴──────┬───────┴───────┬────────┘  │
│         │ IPC (socket) │  WebSocket    │ direct     │
└─────────┼──────────────┼───────────────┼────────────┘
          ▼              ▼               ▼
┌────────────────────────────────────────────────────┐
│              Agent Backend (pi framework)           │
│  ┌────────────┬──────────────┬──────────────────┐  │
│  │ Session    │  Tool        │  Vision Model    │  │
│  │ Manager    │  Registry    │  (Gemini)        │  │
│  └────────────┴──────────────┴──────────────────┘  │
└────────────────────────────────────────────────────┘
```

- **VS Code extension** communicates with the agent over a Unix socket (IPC). It provides the page viewer webview and terminal integration.
- **Web server** (`npm run web`) serves a browser UI with WebSocket for real-time streaming. Supports multiple concurrent sessions.
- **CLI** runs the agent directly in the terminal using pi's TUI.

All three interfaces share the same agent backend built on `@mariozechner/pi-coding-agent`.

## Configuration

### Environment variables

Set in `.chronos/.env`:

```
GEMINI_API_KEY=your-key-here
```

### CLI flags

| Flag | Description | Default |
|------|-------------|---------|
| `--source <path>` | Path to source directory (required for CLI) | — |
| `--task <skill>` | Run a specific skill | — (interactive mode) |
| `--model <name>` | Override the default model | — |
| `--workspace <path>` | Workspace root | `./data` |

### Server flags

| Flag | Description | Default |
|------|-------------|---------|
| `--port <number>` | HTTP server port | `3000` |
| `--model <name>` | Override the default model | — |
| `--workspace <path>` | Workspace root | `./data` |
| `--workspaces-dir <path>` | Parent dir to discover multiple workspaces | — |

## VS Code commands

| Command | Description |
|---------|-------------|
| **Chronos: Init Workspace** | Scaffold workspace structure and set API key |
| **Chronos: Start Agent Session** | Pick a source and launch the agent |
| **Chronos: Show Page** | Open a specific page in the viewer |
| **Chronos: Import Sources** | Batch-import files from a folder |
| **Chronos: Window Setup** | Configure VS Code layout for Chronos |

The extension also provides clickable `[view p.N]` links in the terminal — click to open any page in the viewer.

## Memory system

The agent maintains persistent memory across sessions:

- **Daily notes** (`memory/YYYY-MM-DD.md`) — raw logs of what happened in each session
- **Long-term memory** (`MEMORY.md`) — curated decisions, lessons, patterns
- **Per-source memory** (`memory/<source-name>.md`) — document-specific findings like page ranges, section boundaries, and structural observations

Memory files survive session restarts and are loaded automatically when the agent starts or switches sources.

## Development

```bash
# Run the agent in dev mode (no build step)
npm start -- --source <path> --workspace <path>

# Run the web server in dev mode
npm run web -- --workspace <path>

# Build for distribution
npm run build

# Build the VS Code extension
cd chronos-vscode && npm install && npm run build
```

## License

See [LICENSE](LICENSE) for details.
