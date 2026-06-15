# Chronos Extension — Testing

## Automated: RPC spike / version canary

```
node scripts/rpc-spike.mjs [path-to-pi]
```

Spawns `pi --mode rpc` in a throwaway fixture workspace and asserts the JSONL
protocol contract the extension depends on: readiness via `get_state`, chronos
pi-package loading (`select-source` registered), `get_available_models`, and
the `extension_ui_request`/`extension_ui_response` round trip (including the
fact that slash-command `prompt` responses arrive only after the handler
finishes). Run this after upgrading the global `pi` install to detect protocol
drift. Last verified: pi 0.79.1 (2026-06-11).

## VS Code integration test

```
node test/run-ui-test.mjs
```

Launches VS Code (local binary) with the dev extension against a fixture
workspace and asserts: setting contribution, `chronos.startSession` opens the
combined panel, the webview bundle boots (ready handshake), and the pi RPC
subprocess starts and stays alive.

## Manual smoke checklist (combined viewer + chat UI)

Run with F5 / `node test/run-ui-test.mjs` won't cover interaction — use a real
workspace with at least one imported source and `chronos.ui: "chat"`.

1. `Chronos: Start Agent Session` → one panel: page viewer left, chat right,
   header with Source/Model selectors and History/New buttons.
2. Pick a source in the header → viewer shows page 1, model acknowledges the
   selection in chat.
3. Send a prompt → user note appears, assistant text streams as markdown with
   a caret; tool calls render as ledger-style cards (spinner → result).
4. Click a `❏ p. N` provenance chip in an answer → viewer jumps to that page
   (with the region crop if the chip carries a `§` selection).
5. Navigate in the viewer (arrows, page input, ±10, zoom, Fit, Ctrl+scroll);
   "Full page" appears when a crop is shown.
6. Press Stop while streaming → agent aborts; Send becomes Steer while running.
7. Trigger a bash tool (non-yolo) → in-panel Allow/Deny dialog; both unblock.
8. History → drawer lists past sessions; Resume rebuilds the chat; New starts
   a fresh session.
9. Switch model in the header → header reflects it; next turn uses it.
10. Kill the pi pid → exit banner + Restart revives with history intact.
11. `show_text` from the agent renders the text view with highlight scrolled
    into view.
12. Set `chronos.ui` back to `terminal` → TUI flow unchanged (separate viewer
    panel, terminal links).
13. Expert subagents: a prompt that triggers the `task` tool renders a
    standalone bronze-railed card ("Expert task-1 — prompt…", spinner →
    ✓ with model and turn count) instead of an activity-group entry. A
    follow-up `task` call shows a "follow-up" tag on its own card.
14. Click an expert card → full-pane transcript drawer: orchestrator
    questions right-aligned (with clickable `p. N` chips), expert replies as
    markdown, live "thinking…" bubble while a follow-up streams. Esc or ✕
    closes; the footer names the `task-N` id. A failed `task` call (bad
    model / unknown task_id) falls back to a plain expandable tool card.
15. Batch subagents: confirm a `task_batch` call (after the mandatory
    confirmation protocol) renders one batch card ("Batch · N experts ·
    model  ✓X ✗Y") with a chip grid (one chip per page: `task-K` · `p.N` ✓/✗).
    Clicking a chip opens that page's expert transcript drawer — the first
    turn comes from the batch result, and any later `task` follow-up on that
    `task_id` appears as a subsequent turn in the same drawer. A batch that
    errors before spawning (no source, bad output_file template) falls back
    to a plain tool card.
16. Import recovery: start `Chronos: Import Sources` on a multi-page PDF and
    kill VS Code (or the window) mid-conversion. The source must NOT appear in
    the source picker (it has no `png/`, only `.png.partial/` + `.importing.json`).
    Relaunch → a warning offers **Resume**/**Discard**/**Later**. Resume finishes
    the conversion (skipping already-rendered pages) and the source then appears;
    Discard removes the partial data. Re-running **Import Sources** also surfaces
    the prompt.
