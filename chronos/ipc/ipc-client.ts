import { connect, type Socket } from "node:net";

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

let socket: Socket | null = null;
let ipcConnected = false;

export function connectIpc(): boolean {
  const socketPath = process.env.CHRONOS_IPC_SOCKET;
  if (!socketPath) return false;

  socket = connect(socketPath);
  ipcConnected = true;

  socket.on("error", () => {
    socket = null;
    ipcConnected = false;
  });
  socket.on("close", () => {
    socket = null;
    ipcConnected = false;
  });

  return true;
}

export function isIpcConnected(): boolean {
  return ipcConnected;
}

export function sendToExtension(msg: AgentToExtensionMessage): void {
  if (!socket) return;
  socket.write(JSON.stringify(msg) + "\n");
}

export function onExtensionMessage(handler: (msg: ExtensionToAgentMessage) => void): void {
  if (!socket) return;
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as ExtensionToAgentMessage;
        handler(msg);
      } catch {
        // Ignore malformed messages
      }
    }
  });
}

export function disconnectIpc(): void {
  if (!socket) return;
  socket.end();
  socket = null;
  ipcConnected = false;
}
