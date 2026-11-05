// Rebuilds a streaming assistant message from pi >=0.84 `message_update` deltas.
// Pure TS (no DOM/Lit) so it runs under node:test.
import type { AssistantMessage, AssistantMessageEvent, Usage } from "../main/rpc/rpc-types";

type Block = AssistantMessage["content"][number];

export class StreamAssembler {
  private base: AssistantMessage | null = null;
  private blocks = new Map<number, Block>();
  private usage: Usage | undefined;
  private partial: AssistantMessage | null = null;

  get current(): AssistantMessage | null {
    return this.partial;
  }

  start(message: AssistantMessage): void {
    this.base = message;
    this.blocks = new Map();
    this.usage = undefined;
    this.partial = message;
  }

  /** Apply one delta; returns a NEW message object, or null if no message has started. */
  apply(ev: AssistantMessageEvent, usage?: Usage): AssistantMessage | null {
    if (!this.base) return null;
    if (usage) this.usage = usage;
    switch (ev.type) {
      case "text_start":
        this.blocks.set(ev.contentIndex, { type: "text", text: "" });
        break;
      case "thinking_start":
        this.blocks.set(ev.contentIndex, { type: "thinking", thinking: "" });
        break;
      case "text_delta": {
        const b = this.blocks.get(ev.contentIndex);
        const prev = b?.type === "text" ? b.text : "";
        this.blocks.set(ev.contentIndex, { type: "text", text: prev + ev.delta });
        break;
      }
      case "thinking_delta": {
        const b = this.blocks.get(ev.contentIndex);
        const prev = b?.type === "thinking" ? b.thinking : "";
        this.blocks.set(ev.contentIndex, { type: "thinking", thinking: prev + ev.delta });
        break;
      }
      case "text_end":
        this.blocks.set(ev.contentIndex, { type: "text", text: ev.content });
        break;
      case "thinking_end":
        this.blocks.set(ev.contentIndex, { type: "thinking", thinking: ev.content });
        break;
      case "toolcall_end":
        this.blocks.set(ev.contentIndex, ev.toolCall);
        break;
      // toolcall_start/_delta carry partial JSON; tool calls are not rendered until
      // toolcall_end, so they are omitted from the partial. start/done/error: no content change.
      default:
        break;
    }
    const content = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    const next: AssistantMessage = { ...this.base, content };
    if (this.usage) (next as AssistantMessage & { usage?: Usage }).usage = this.usage;
    this.partial = next;
    return next;
  }

  end(message: AssistantMessage): AssistantMessage {
    this.base = null;
    this.blocks = new Map();
    this.usage = undefined;
    this.partial = null;
    return message;
  }
}
