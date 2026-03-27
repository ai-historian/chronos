import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Load from primary path, fall back to default if primary doesn't exist. */
function loadWithFallback(primary: string, fallback: string): string {
  const path = existsSync(primary) ? primary : fallback;
  return readFileSync(path, "utf-8").trim();
}

function loadDocumentMemory(memoryDir: string, sourceName: string): string {
  const memoryPath = join(memoryDir, `${sourceName}.md`);
  if (existsSync(memoryPath)) {
    return readFileSync(memoryPath, "utf-8").trim();
  }
  return "";
}

export function buildSystemPrompt(
  sourceDir: string | null,
  sourceName: string | null,
  dataDir: string
): string {
  const chronosDir = join(dataDir, ".chronos");
  const memoryDir = join(dataDir, "memory");
  const skillsDir = join(dataDir, "skills");
  const sharedDataDir = join(dataDir, "data");
  const promptPath = join(__dirname, "prompts", "system-prompt.md");

  const promptsDir = join(__dirname, "prompts");
  const soul = loadWithFallback(join(chronosDir, "SOUL.MD"), join(promptsDir, "soul.md"));
  const agents = loadWithFallback(join(chronosDir, "AGENTS.md"), join(promptsDir, "agents.md"));
  const template = readFileSync(promptPath, "utf-8");

  const resolvedSourceDir = sourceDir ?? "(no source selected)";
  const resolvedSourceName = sourceName ?? "(no source selected)";
  const documentMemory = sourceDir && sourceName ? loadDocumentMemory(memoryDir, sourceName) : "";
  const sourceMemoryPath = sourceName ? join(memoryDir, `${sourceName}.md`) : "(no source selected)";
  const sourceDataDir = sourceName ? join(sharedDataDir, sourceName) : "(no source selected)";

  return template
    .replaceAll("{{soul}}", soul)
    .replaceAll("{{agents}}", agents)
    .replaceAll("{{sourceDir}}", resolvedSourceDir)
    .replaceAll("{{sourceName}}", resolvedSourceName)
    .replaceAll("{{agentDir}}", memoryDir)
    .replaceAll("{{sourceMemoryPath}}", sourceMemoryPath)
    .replaceAll("{{sourceDataDir}}", sourceDataDir)
    .replaceAll("{{skillsDir}}", skillsDir)
    .replaceAll("{{dataDir}}", sharedDataDir)
    .replaceAll("{{documentMemory}}", documentMemory);
}
