import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import type { AgentToExtensionMessage, ExtensionToAgentMessage } from "./protocol";

export class IpcServer {
  private server: Server;
  private client: Socket | null = null;
  private handler: ((msg: AgentToExtensionMessage) => void) | null = null;
  private connectionWaiters: (() => void)[] = [];
  readonly socketPath: string;

  constructor() {
    this.socketPath = join(tmpdir(), `chronos-${randomBytes(4).toString("hex")}.sock`);

    // Clean up stale socket file
    try {
      unlinkSync(this.socketPath);
    } catch {
      // File doesn't exist — fine
    }

    this.server = createServer((socket) => {
      // Accept one client at a time
      if (this.client) {
        this.client.destroy();
      }
      this.client = socket;

      // Notify anyone waiting for a connection
      for (const waiter of this.connectionWaiters) waiter();
      this.connectionWaiters = [];

      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as AgentToExtensionMessage;
            this.handler?.(msg);
          } catch {
            // Ignore malformed messages
          }
        }
      });

      socket.on("close", () => {
        if (this.client === socket) {
          this.client = null;
        }
      });

      socket.on("error", () => {
        if (this.client === socket) {
          this.client = null;
        }
      });
    });

    this.server.listen(this.socketPath);
  }

  onMessage(handler: (msg: AgentToExtensionMessage) => void): void {
    this.handler = handler;
  }

  send(msg: ExtensionToAgentMessage): void {
    if (!this.client) return;
    this.client.write(JSON.stringify(msg) + "\n");
  }

  get isConnected(): boolean {
    return this.client !== null;
  }

  waitForConnection(timeoutMs = 30000): Promise<boolean> {
    if (this.client) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.connectionWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  dispose(): void {
    this.client?.destroy();
    this.client = null;
    this.server.close();
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Already cleaned up
    }
  }
}
