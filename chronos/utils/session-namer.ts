/**
 * Summarise a session's user prompts into a short, descriptive title using the
 * cheapest model pi has auth for. Best-effort and provider-agnostic: returns
 * undefined (so the caller keeps the first-message fallback) on any failure —
 * no models configured, offline, the call errors, or the output is unusable.
 *
 * Only USER prompts are sent — never assistant replies, tool results, or page
 * images — so the input stays tiny, cheap, and free of extracted content.
 */
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { pickCheapestModelSpec, resolveExpertModel } from "./resolve-model.js";

const MAX_PROMPTS = 6;
const MAX_INPUT_CHARS = 4000;
const MAX_TITLE_CHARS = 80;

const SYSTEM_PROMPT =
  "You write concise titles for work sessions in a tool that extracts structured data from " +
  "historical documents. Given the user's prompts from one session, reply with a single 3–8 " +
  "word title in Title Case that captures the task (e.g. \"Extract Baptism Records, 1801–1815\"). " +
  "Reply with the title only — no quotes, no trailing punctuation, no preamble.";

function cleanTitle(raw: string): string | undefined {
  let t = (raw.split("\n").find((l) => l.trim()) ?? "").trim();
  t = t.replace(/^["'`*]+/, "").replace(/["'`*]+$/, "").replace(/[.\s]+$/, "").trim();
  if (!t) return undefined;
  return t.length > MAX_TITLE_CHARS ? t.slice(0, MAX_TITLE_CHARS).trim() : t;
}

export async function generateSessionTitle(
  registry: ModelRegistry,
  userPrompts: string[],
): Promise<string | undefined> {
  const prompts = userPrompts.map((p) => p.trim()).filter(Boolean).slice(0, MAX_PROMPTS);
  if (prompts.length === 0) return undefined;

  const spec = pickCheapestModelSpec(registry);
  if (!spec) return undefined;
  const resolved = await resolveExpertModel(spec, registry, undefined, false);
  if (!resolved.ok) return undefined;

  const joined = prompts.map((p, i) => `${i + 1}. ${p}`).join("\n").slice(0, MAX_INPUT_CHARS);
  const userMessage: UserMessage = {
    role: "user",
    content: `User prompts from this session:\n${joined}\n\nTitle:`,
    timestamp: Date.now(),
  };

  try {
    const response = await complete(
      resolved.model,
      { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
      { apiKey: resolved.apiKey, headers: resolved.headers },
    );
    if (response.stopReason === "error") return undefined;
    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    return cleanTitle(text);
  } catch {
    return undefined;
  }
}
