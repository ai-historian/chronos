# Initialize a workspace

A Chronos **workspace** is just a folder. Open the folder you want to work in
(`File ▸ Open Folder…`), then run **Init workspace** to scaffold it:

```
sources/   your source directories (each with a png/ subfolder)
data/      per-source extraction results and outputs
memory/    agent memory (MEMORY.MD + per-source notes)
skills/    reusable task instructions (SKILL.md)
sessions/  agent session logs (auto-generated)
.chronos/  provider keys (.env) and settings
```

Existing files are never overwritten, so it's safe to re-run on a folder that's
already set up.

Next, add pages under `sources/` manually, or use **Chronos: Import Sources** to
convert PDFs and images automatically.
