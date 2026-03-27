import type { Message } from "@mariozechner/pi-ai";

/**
 * Shared mutable state holding the last ask_page conversation.
 * Passed to both createAnalyzePageTool and createFollowUpQuestionTool
 * so that follow-up questions can continue the same conversation.
 */
export interface PageExpertState {
  /** System prompt used in the last ask_page call. */
  systemPrompt: string | undefined;
  /** Full message history of the last ask_page call, including the assistant reply. */
  messages: Message[];
  /** Model ID used in the last ask_page call. */
  modelId: string | undefined;
}

export function createPageExpertState(): PageExpertState {
  return { systemPrompt: undefined, messages: [], modelId: undefined };
}
