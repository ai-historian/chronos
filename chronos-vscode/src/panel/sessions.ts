import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ChronosSessionInfo } from "./webview-protocol";

// Lightweight scan of pi session JSONL files in <workspace>/sessions.
// Format (session-manager v3): line 1 is {type:"session", id, timestamp, cwd},
// then entries; "message" entries carry conversation messages, "session_info"
// entries carry an optional user-defined display name.

function firstTextOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") return block.text;
    }
  }
  return undefined;
}

// Session files can reach tens of MB (vision tool results embed base64 page
// images), so the drawer scan avoids JSON.parse on bulk lines: it counts by
// line prefix and only parses the header, the first user message, and
// session_info entries. Results are cached by (mtime, size).
const sessionInfoCache = new Map<string, { mtime: number; size: number; info: ChronosSessionInfo }>();

function parseSessionFile(filePath: string): ChronosSessionInfo | undefined {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return undefined;
  }
  const cached = sessionInfoCache.get(filePath);
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
    return cached.info;
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
  const lines = raw.split("\n");
  let header: any;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return undefined;
  }
  if (header?.type !== "session") return undefined;

  let name: string | undefined;
  let firstUserMessage: string | undefined;
  let messageCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('{"type":"message"')) {
      messageCount++;
      if (!firstUserMessage && line.includes('"role":"user"')) {
        try {
          const entry = JSON.parse(line);
          firstUserMessage = firstTextOf(entry.message?.content)?.slice(0, 200);
        } catch {
          // skip malformed line
        }
      }
    } else if (line.startsWith('{"type":"session_info"')) {
      try {
        const entry = JSON.parse(line);
        if (entry.name) name = entry.name;
      } catch {
        // skip malformed line
      }
    }
  }

  const info: ChronosSessionInfo = {
    path: filePath,
    name: name ?? firstUserMessage?.slice(0, 80) ?? "(empty session)",
    timestamp: Date.parse(header.timestamp) || stat.mtimeMs,
    messageCount,
    firstUserMessage,
    sizeBytes: stat.size,
  };
  sessionInfoCache.set(filePath, { mtime: stat.mtimeMs, size: stat.size, info });
  return info;
}

// pi's default per-project session location: ~/.pi/agent/sessions/--<cwd>--
// (used by sessions created before the extension started pinning
// PI_CODING_AGENT_SESSION_DIR to <workspace>/sessions).
function defaultPiSessionDir(workspaceDir: string): string {
  const encoded = `--${resolve(workspaceDir).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(homedir(), ".pi", "agent", "sessions", encoded);
}

function scanDir(dir: string, sessions: Map<string, ChronosSessionInfo>): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return;
  }
  for (const file of files) {
    const info = parseSessionFile(join(dir, file));
    // Key by file basename (timestamp_sessionId) so the same session never
    // shows twice if both locations somehow contain it
    if (info && !sessions.has(file)) sessions.set(file, info);
  }
}

// Full transcript of a session file. The RPC get_messages command returns the
// agent's LLM *context*, which loses early turns to compaction on long
// sessions — the JSONL file keeps everything. Entries form a parent-linked
// tree; walking up from the last entry yields the active branch only.
export function readSessionMessages(sessionFile: string): any[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(sessionFile, "utf-8");
  } catch {
    return undefined;
  }
  const entries: any[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // skip malformed line
    }
  }
  if (entries.length === 0) return undefined;

  const byId = new Map<string, any>();
  for (const entry of entries) {
    if (entry.id) byId.set(entry.id, entry);
  }
  const path: any[] = [];
  const seen = new Set<any>();
  let current: any = entries[entries.length - 1];
  while (current && !seen.has(current)) {
    seen.add(current);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();
  const messages: any[] = [];
  for (const entry of path) {
    if (entry.type === "message" && entry.message) {
      messages.push(entry.message);
    } else if (entry.type === "compaction") {
      // Synthetic marker so the UI can show where context was compacted.
      // Uses a custom role — renderers ignore unknown roles by default.
      messages.push({
        role: "compaction_marker",
        summary: entry.summary ?? "",
        tokensBefore: entry.tokensBefore,
        timestamp: Date.parse(entry.timestamp) || undefined,
      });
    }
  }
  return messages;
}

export function listSessions(workspaceDir: string): ChronosSessionInfo[] {
  const sessions = new Map<string, ChronosSessionInfo>();
  scanDir(join(workspaceDir, "sessions"), sessions);
  scanDir(defaultPiSessionDir(workspaceDir), sessions);
  return [...sessions.values()].sort((a, b) => b.timestamp - a.timestamp);
}
