import { Type } from "@sinclair/typebox";
import { complete, getModel } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { PageExpertState } from "./page-expert-state.js";

const followUpParams = Type.Object({
  prompt: Type.String({ description: "Follow-up question to ask the page expert about the last analyzed page." }),
});

export function createFollowUpQuestionTool(state: PageExpertState, description: string): ToolDefinition<typeof followUpParams> {
  return {
    name: "follow_up_question",
    label: "Follow-up Question",
    description,
    parameters: followUpParams,
    async execute(_toolCallId, params) {
      if (!state.modelId || state.messages.length === 0) {
        return {
          content: [{ type: "text", text: "No active page conversation. Call ask_page first." }],
          details: {},
        };
      }

      const followUpMessage = {
        role: "user" as const,
        content: params.prompt,
        timestamp: Date.now(),
      };

      const updatedMessages = [...state.messages, followUpMessage];
      const model = getModel("google", state.modelId as any);

      const response = await complete(model, {
        systemPrompt: state.systemPrompt,
        messages: updatedMessages,
      });

      // Append to conversation so further follow-ups can chain
      state.messages = [...updatedMessages, response];

      const text = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");

      const cost = response.usage?.cost;
      const costStr = cost
        ? ` [cost: $${(cost.input + cost.output + cost.cacheRead).toFixed(4)}]`
        : "";

      return {
        content: [{ type: "text", text: text || "(empty response)" }],
        details: { model: state.modelId, cost: costStr },
      };
    },
  };
}
