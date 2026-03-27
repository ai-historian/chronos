import { config } from "dotenv";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config(); // load .env

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE = join(__dirname, "..", "data");

export interface CliArgs {
  sourceDir: string;
  task?: string;
  model?: string;
  workspace: string;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): CliArgs {
  let sourceDir: string | undefined;
  let task: string | undefined;
  let model: string | undefined;
  let workspace: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) {
      sourceDir = argv[++i];
    } else if (argv[i] === "--task" && argv[i + 1]) {
      task = argv[++i];
    } else if (argv[i] === "--model" && argv[i + 1]) {
      model = argv[++i];
    } else if (argv[i] === "--workspace" && argv[i + 1]) {
      workspace = argv[++i];
    }
  }

  if (!sourceDir) {
    console.error("Usage: npx chronos --source <path> [--task <skill-name>] [--workspace <path>]");
    process.exit(1);
  }

  return {
    sourceDir: resolve(sourceDir),
    task,
    model,
    workspace: resolve(workspace ?? DEFAULT_WORKSPACE),
  };
}
