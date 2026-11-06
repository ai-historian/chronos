// <chronos-code-editor>: a CodeMirror 6 editor for one workspace text file.
// Emits `dirty-changed` ({ dirty }) when the doc starts/stops differing from the last-saved
// content and `save-requested` on Ctrl/Cmd+S.
import { LitElement, html, type TemplateResult } from "lit";
import { Compartment, EditorState, Prec, type Extension, type Text } from "@codemirror/state";
import { EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { oneDark } from "@codemirror/theme-one-dark";

function languageFor(path: string): Extension {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "json") return json();
  if (ext === "md" || ext === "markdown") return markdown();
  if (ext === "yaml" || ext === "yml") return yaml();
  return [];
}

function isDark(): boolean {
  return document.documentElement.dataset.theme === "dark";
}

export class ChronosCodeEditor extends LitElement {
  static properties = {
    path: { type: String },
    content: { type: String },
    readOnly: { type: Boolean },
  };

  declare path: string;
  /** Initial content; later replacements go through reload(). */
  declare content: string;
  declare readOnly: boolean;

  private view: EditorView | null = null;
  /** State kept across a disconnect so a reparented editor (keyed repeat moves) comes back intact. */
  private parked: EditorState | null = null;
  /** destroy() was called: the tab is closed for good. */
  private closed = false;
  private saved: Text | null = null;
  private dirty = false;
  private readonly theme = new Compartment();
  private readonly onTheme = () => this.view?.dispatch({ effects: this.theme.reconfigure(isDark() ? oneDark : []) });

  constructor() {
    super();
    this.path = "";
    this.content = "";
    this.readOnly = false;
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("chronos-theme-changed", this.onTheme);
    // Re-attached after a disconnect that destroyed the view: rebuild it from the parked state.
    const parent = this.querySelector<HTMLElement>(".ce-root");
    if (!this.view && this.parked && parent && !this.closed) {
      this.view = new EditorView({ parent, state: this.parked });
      this.parked = null;
    }
    this.onTheme();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("chronos-theme-changed", this.onTheme);
    // CodeMirror registers window/document listeners; release them unless this is just a move
    // (a keyed repeat re-inserts the node synchronously, so check after the current task).
    queueMicrotask(() => {
      if (this.isConnected || !this.view) return;
      this.parked = this.view.state;
      this.view.destroy();
      this.view = null;
    });
  }

  /** Tear the editor down for good (its tab was closed). */
  destroy(): void {
    this.closed = true;
    this.parked = null;
    this.view?.destroy();
    this.view = null;
  }

  render(): TemplateResult {
    return html`<div class="ce-root"></div>`;
  }

  protected firstUpdated(): void {
    if (this.closed) return;
    const parent = this.querySelector<HTMLElement>(".ce-root")!;
    this.view = new EditorView({ parent, state: this.makeState(this.content) });
    this.saved = this.view.state.doc;
  }

  /** The current document text (with the file's original line separator). */
  getContent(): string {
    const state = this.view?.state ?? this.parked;
    return state ? state.sliceDoc() : this.content;
  }

  /** Record `content` as what is on disk now (after a successful save). */
  setSavedContent(content: string): void {
    const state = this.view?.state ?? this.parked;
    if (!state) return;
    this.saved = state.toText(content);
    this.updateDirty();
  }

  /** Replace the document with fresh on-disk content (Reload); clears dirty and undo history. */
  reload(content: string): void {
    this.content = content;
    if (this.closed) return;
    const state = this.makeState(content);
    if (this.view) this.view.setState(state);
    else if (this.parked) this.parked = state;
    else return; // not created yet: firstUpdated uses `content`
    this.saved = state.doc;
    this.updateDirty();
  }

  focusEditor(): void {
    this.view?.focus();
  }

  private makeState(content: string): EditorState {
    const crlf = content.includes("\r\n");
    return EditorState.create({
      doc: content,
      extensions: [
        Prec.highest(
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                this.dispatchEvent(new CustomEvent("save-requested", { bubbles: true, composed: true }));
                return true;
              },
            },
          ]),
        ),
        lineNumbers(),
        history(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.lineWrapping,
        languageFor(this.path),
        this.theme.of(isDark() ? oneDark : []),
        crlf ? EditorState.lineSeparator.of("\r\n") : [],
        EditorState.readOnly.of(this.readOnly),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) this.updateDirty();
        }),
      ],
    });
  }

  private updateDirty(): void {
    const state = this.view?.state ?? this.parked;
    if (!state || !this.saved) return;
    const doc = state.doc;
    const dirty = doc.length !== this.saved.length || !doc.eq(this.saved);
    if (dirty === this.dirty) return;
    this.dirty = dirty;
    this.dispatchEvent(new CustomEvent("dirty-changed", { detail: { dirty }, bubbles: true, composed: true }));
  }
}

customElements.define("chronos-code-editor", ChronosCodeEditor);

declare global {
  interface HTMLElementTagNameMap {
    "chronos-code-editor": ChronosCodeEditor;
  }
  interface WindowEventMap {
    "chronos-theme-changed": CustomEvent<{ name: string }>;
  }
}
