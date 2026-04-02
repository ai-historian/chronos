# Chronos

AI-powered agent for digitizing historical German city directories. Chronos combines a document analysis agent with a VS Code extension to analyze scanned page images, extract structured data, and build knowledge about archival sources.

![Chronos demo](demo.png)

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [VS Code](https://code.visualstudio.com/) (v1.110+)
- A [Gemini API key](https://aistudio.google.com/apikey) for the vision model

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

```bash
pi install https://github.com/ai-historian/history-agent
```

This clones the repository, installs dependencies, and registers the Chronos extension, tools, skills, and prompts with pi.

### 3. Install the VS Code extension

Download the latest `.vsix` from [GitHub Releases](https://github.com/ai-historian/history-agent/releases) and install it:

```bash
# Linux / macOS
code --install-extension chronos-0.1.0.vsix

# Windows (use code.cmd so the CLI runs instead of launching the GUI)
code.cmd --install-extension chronos-0.1.0.vsix
```

Alternatively, open VS Code, go to the Extensions sidebar, click the `···` menu, choose **Install from VSIX…**, and select the file.

## Getting started

### 1. Initialize a workspace

Open VS Code in an empty folder. Press `Ctrl+Shift+P` and run **Chronos: Init Workspace**. This creates the workspace structure and prompts for your Gemini API key.

### 2. Import sources

Press `Ctrl+Shift+P` and run **Chronos: Import Sources**. Select a folder containing your source material — PDFs, images (PNG, JPG, TIFF, BMP), or text files. Each file within the folder is treated as a source. PDFs are automatically converted to page images. You can import additional sources at any time by running the command again.

### 3. Start the agent

Press `Ctrl+Shift+P` and run **Chronos: Start Agent Session**. The page viewer opens and a `pi` terminal starts.

On first startup, type `/login` in the terminal to log into your AI provider account (e.g. Anthropic, Google). Without this, no models will be available.

Type `/select-source` to pick a source and begin working.

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

## Documentation

See [DOCS.md](DOCS.md) for technical details on workspace structure, tools, skills, memory, and the VS Code extension.

## License

See [LICENSE](LICENSE) for details.
