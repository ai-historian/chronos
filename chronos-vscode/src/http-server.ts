import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AgentToExtensionMessage } from "./protocol";

export class HttpServer {
  private server: Server;
  private handler: ((msg: AgentToExtensionMessage) => void) | null = null;
  port = 0;
  readonly ready: Promise<void>;

  constructor() {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.ready = new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        resolve();
      });
    });
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
    this.server.close();
  }
}
