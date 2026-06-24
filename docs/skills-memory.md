# Skills & memory

<p class="lead" markdown="span">Two file-based systems make Chronos better the more you use it:
<strong>skills</strong> capture repeatable tasks you can re-run by name, and <strong>memory</strong>
accumulates what Chronos learns about your documents and reloads it automatically.</p>

## Skills

A skill is a self-contained task definition: a folder under `skills/<skill-name>/` containing a `SKILL.md`
with YAML frontmatter and a body of instructions. Invoke it from the chat with `/skill:<name>`.

```markdown title="skills/extract-entries/SKILL.md"
---
name: extract-entries
description: Extract surname, names, trade, and address from directory pages
requires: schema.json
---

# Instructions

For each page in the range I give you, dispatch a vision expert and extract
every directory entry as a row with: surname, first_names, trade, address.

Include chronos_page (the file-system page index) on every row, and a
chronos_bbox around each entry's line. Write the result to
data/<source>/entries.json as a JSON array.
```

| Frontmatter key | Meaning |
|---|---|
| `name` | The skill's name. Use a slug — lowercase letters, digits, and hyphens (`^[a-z0-9-]+$`, no leading/trailing or doubled hyphens, max 64 chars) — matching the skill's folder name. |
| `description` | A one-line summary shown in the slash-command menu. **Required** — a skill with an empty description won't appear. |
| `requires` | Comma-separated filenames that should exist in the source before the skill runs (leave blank if none). A precondition the agent respects; it isn't enforced in code. |

!!! note
    Chronos ships with no built-in skills — `skills/` is yours to fill. Skills live in `skills/`, never
    inside a source folder (sources hold only page images and outputs). If a new skill doesn't appear in the
    `/` menu, reload the window so the workspace skills are re-read.

## Memory

Memory is plain markdown the agent reads and writes, in two scopes:

| File | Holds |
|---|---|
| `memory/MEMORY.MD` | **Global** — cross-source insights: recurring conventions, abbreviation patterns, lessons learned, tool tips. |
| `memory/<source-name>.md` | **Per-source** — everything about one document: table of contents, page ranges for sections, layout observations, anomalies, progress notes. |

Both files are read fresh and inlined into the agent's system prompt **every turn**, so memory is loaded
automatically when a session starts or you switch sources, and it survives restarts. The per-source file is
keyed by the source's folder name, so each document gets its own.

!!! warning "MEMORY.MD is case-sensitive"
    The global file is `MEMORY.MD` — uppercase name, uppercase `.MD` extension. On a case-sensitive
    filesystem a `memory.md` or `MEMORY.md` won't be picked up.

### How Chronos keeps memory

Chronos is instructed to write memory **early and often** — after every 5–10 pages, not at the end — because
an interrupted session loses anything unpersisted. It reads a file before writing and appends, rather than
overwriting, and keeps all document analysis in the per-source file rather than scattering notes. You can
read and edit these files yourself at any time; they're just markdown in your workspace.

!!! tip
    Memory is injected into the system prompt on every turn, so very large memory files add token cost each
    turn. Keep them tidy — durable findings, not raw transcripts.
