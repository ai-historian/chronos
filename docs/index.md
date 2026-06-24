# Chronos

<p class="lead" markdown="span">Chronos is an AI agent that works alongside historians to read scanned primary
sources — address directories, parish registers, ledgers, census rolls — and extract clean,
structured datasets in which **every value traces back to the pixels it came from**. It lives
inside VS&nbsp;Code as a page viewer and a chat, driven by per-page vision experts.</p>

[Install Chronos](installation.md){ .md-button .md-button--primary }
[Your first extraction](getting-started.md){ .md-button }
[GitHub](https://github.com/ai-historian/chronos){ .md-button }

<figure markdown="span">
  ![The Chronos panel in VS Code: a scanned 1864 Frankfurt directory in the page viewer, the chat with a vision expert on the right.](assets/img/panel.png)
  <figcaption>The Chronos panel — page viewer on the left, chat on the right. <b>Chronos UI rendered with sample data.</b></figcaption>
</figure>

## What Chronos is

Chronos pairs a document-analysis **agent** with a **VS&nbsp;Code extension**. You point it at a
folder of scanned pages, tell it what to pull out, and it samples pages, dispatches vision experts,
writes structured output to disk, and cites each record back to a page and region you can click to
inspect. It adapts to each document and remembers what it learns between sessions.

<div class="feature-grid">
  <div class="feature"><div class="fi">⌖</div><h3>Cited to the pixel</h3><p>Every row can carry a page and a bounding box. Click a citation and the exact region lights up — no more hunting through scans.</p></div>
  <div class="feature"><div class="fi">✦</div><h3>Per-page vision experts</h3><p>The orchestrator dispatches a dedicated vision model per page that can zoom into dense tables and faint ink on its own.</p></div>
  <div class="feature"><div class="fi">▤</div><h3>Structured output</h3><p>Results land as JSON in <code>data/</code> and render as sortable tables in the panel, ready to export.</p></div>
  <div class="feature"><div class="fi">◈</div><h3>Provider-agnostic</h3><p>Use any vision model your key covers — Anthropic, Google, OpenAI and more. Mix a cheap model for routine pages with a stronger one for hard ones.</p></div>
  <div class="feature"><div class="fi">⚑</div><h3>Human-in-the-loop</h3><p>Experts are read-only by default. Running commands or writing files takes an explicit grant and a confirmation you control.</p></div>
  <div class="feature"><div class="fi">⟳</div><h3>Learns over time</h3><p>Skills capture repeatable tasks; memory accumulates per-source and cross-source knowledge that loads automatically next session.</p></div>
</div>

## How a session flows

<ol class="steps">
  <li><strong>Set up once</strong><p>Initialise a workspace and import your sources. PDFs are converted to page images automatically; the import is crash-safe.</p></li>
  <li><strong>Pick a source and ask</strong><p>Choose a source in the panel header and describe what you want extracted, in plain language or via a saved skill.</p></li>
  <li><strong>Chronos analyses</strong><p>It lists pages, samples a few to learn the layout, then dispatches vision experts page-by-page — each able to zoom in where it needs to.</p></li>
  <li><strong>Review cited output</strong><p>Records appear in the Data tab as a table. Click any citation to see the exact region it was read from, outlined on the page.</p></li>
</ol>

!!! info "Two halves, one tool"
    Chronos is split into a **pi-package** (the agent — tools, prompts, hooks) and the
    **VS&nbsp;Code extension** (the viewer + chat that drives it). You never run them separately;
    the extension bootstraps everything on first launch. See [How it works](architecture.md).

## Provenance is the point

A Chronos dataset is not just rows — it is rows you can *verify*. Each record may carry reserved
keys that pin it to its source. They never show up as columns; instead they become a bronze
<span class="chip">p.&nbsp;42</span> citation chip you click to see the evidence:

```json title="data/Frankfurt_1864/entries.json"
[
  { "surname": "Müller",  "trade": "baker", "chronos_page": 42, "chronos_bbox": [0.10, 0.32, 0.80, 0.05] },
  { "surname": "Schmidt", "trade": "smith", "chronos_page": 42, "chronos_bbox": [0.10, 0.38, 0.80, 0.05] }
]
```

Read how this works on [Provenance &amp; bounding boxes](provenance.md) — including an interactive
coordinate playground.
