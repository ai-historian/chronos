# Chronos

AI-powered agent for digitizing historical German city directories. Chronos combines a document analysis agent with a VS Code extension to analyze scanned page images, extract structured data, and build knowledge about archival sources.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [VS Code](https://code.visualstudio.com/) (v1.110+)
- A [Gemini API key](https://aistudio.google.com/apikey) for the vision model
- `mutool` (from [MuPDF](https://mupdf.com/)) if importing PDFs

## Installation

### 1. Install pi (the AI coding agent)

Chronos runs as a package inside [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent), an AI coding agent framework. Install it globally:

```bash
npm install -g @mariozechner/pi-coding-agent
```

Verify it works:

```bash
pi --help
```

### 2. Install the Chronos pi-package

From the project root:

```bash
cd chronos
npm install
pi install .
```

This registers the Chronos extension, tools, skills, and prompts with pi.

### 3. Install the VS Code extension

```bash
cd chronos-vscode
npm install
npm run build
npm run package
code --install-extension chronos-0.3.0.vsix
```

## Getting started

### Initialize a workspace

Open VS Code in an empty folder and run the command **Chronos: Init Workspace** from the command palette (`Ctrl+Shift+P`). This creates the workspace structure and prompts for your Gemini API key.

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

**From VS Code (recommended):**

1. Open a workspace folder in VS Code
2. Run **Chronos: Start Agent Session** from the command palette
3. The page viewer opens and a `pi` terminal starts
4. Type `/select-source` in the terminal to pick a source
5. The page viewer updates and the agent is ready

**From the terminal:**

```bash
cd ~/my-workspace
pi
```

Then type `/select-source` to pick a source and start working.

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

## VS Code commands

| Command | Description |
|---------|-------------|
| **Chronos: Init Workspace** | Scaffold workspace structure and set API key |
| **Chronos: Start Agent Session** | Launch the agent in a terminal with page viewer |
| **Chronos: Show Page** | Open a specific page in the viewer |
| **Chronos: Import Sources** | Batch-import files from a folder |
| **Chronos: Window Setup** | Configure VS Code layout for Chronos |

The extension provides clickable `[view p.N]` links in the terminal — click to open any page in the viewer.

## Memory system

The agent maintains persistent memory across sessions:

- **Global memory** (`memory/MEMORY.MD`) — cross-source insights, recurring conventions, abbreviation patterns, lessons learned
- **Per-source memory** (`memory/<source-name>.md`) — document-specific findings like page ranges, section boundaries, layout observations, and structural notes

Memory files survive session restarts and are loaded automatically when the agent starts or switches sources.

## Configuration

### Environment variables

Set in `.chronos/.env`:

```
GEMINI_API_KEY=your-key-here
```

### pi options

pi supports many options natively. Common ones:

```bash
# Use a specific model
pi --model gemini-2.5-pro

# Continue previous session
pi -c

# Resume a specific session
pi -r
```

Run `pi --help` for the full list.

## Development

```bash
# Build the pi package
cd chronos && npm run build

# Build the VS Code extension
cd chronos-vscode && npm run build

# Package the VS Code extension
cd chronos-vscode && npm run package
```

## License

See [LICENSE](LICENSE) for details.
