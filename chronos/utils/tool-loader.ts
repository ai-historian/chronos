import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "..", "prompts");

export interface ToolText {
  description: string;
  promptGuidelines?: string[];
}

/**
 * Load a tool's description (and optional prompt guidelines) from a markdown
 * file in `agent/prompts/<filename>`.
 *
 * Format: the file body is the description. If the file contains a `---`
 * separator on its own line, everything after it is treated as prompt
 * guidelines (one per non-empty line).
 */
export function loadToolText(filename: string): ToolText {
  const content = readFileSync(join(PROMPTS_DIR, filename), "utf-8");
  const parts = content.split(/\n---\n/);
  const description = parts[0].trim();
  const promptGuidelines =
    parts.length > 1
      ? parts[1]
          .trim()
          .split(/\n/)
          .filter((l) => l.trim())
      : undefined;
  return { description, promptGuidelines };
}

/**
 * Load a raw prompt file from `agent/prompts/<filename>`.
 * Returns the file contents as-is (trimmed).
 */
export function loadPromptFile(filename: string): string {
  return readFileSync(join(PROMPTS_DIR, filename), "utf-8").trim();
}
