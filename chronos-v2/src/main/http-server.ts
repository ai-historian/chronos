import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AgentToExtensionMessage } from "./protocol";

export class HttpServer {
  private server: Server | null = null;
  private handler: ((msg: AgentToExtensionMessage) => void) | null = null;
  private startPromise: Promise<void> | null = null;
  port = 0;

  // Bind the loopback server lazily — only when the first agent session starts —
  // so merely activating the extension (e.g. on startup, to drive the Getting
  // Started walkthrough) opens no port. Idempotent: repeated calls share one server.
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.startPromise = new Promise((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        resolve();
      });
    });
    return this.startPromise;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "POST" && req.url === "/message") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        try {
          const msg = JSON.parse(body) as AgentToExtensionMessage;
          console.log(`[chronos-http-server] Received message: ${msg.type}`);
          this.handler?.(msg);
        } catch (err) {
          console.error("[chronos-http-server] Error handling message:", err, "body:", body.slice(0, 200));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  }

  onMessage(handler: (msg: AgentToExtensionMessage) => void): void {
    this.handler = handler;
  }

  dispose(): void {
    this.server?.close();
  }
}
