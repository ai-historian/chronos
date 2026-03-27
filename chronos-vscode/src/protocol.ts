// Agent → Extension messages

export interface ShowPageMessage {
  type: "show_page";
  pageId: number;
  totalPages: number;
  sourceDir: string;
  sourceName: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
}

export interface PageListMessage {
  type: "page_list";
  sourceDir: string;
  sourceName: string;
  firstPage: number;
  lastPage: number;
  totalPages: number;
}

export interface TextDeltaMessage {
  type: "text_delta";
  delta: string;
}

export interface ToolStartMessage {
  type: "tool_start";
  toolName: string;
  args: string;
}

export interface ToolEndMessage {
  type: "tool_end";
  toolName: string;
  result: string;
}

export interface TurnEndMessage {
  type: "turn_end";
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export type AgentToExtensionMessage =
  | ShowPageMessage
  | PageListMessage
  | TextDeltaMessage
  | ToolStartMessage
  | ToolEndMessage
  | TurnEndMessage
  | ErrorMessage;

// Extension → Agent messages

export interface PromptMessage {
  type: "prompt";
  text: string;
}

export type ExtensionToAgentMessage = PromptMessage;
