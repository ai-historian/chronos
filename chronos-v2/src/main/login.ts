import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { upsertEnvVar } from "./env-file";
import {
  beginAnthropicLogin,
  completeAnthropicLogin,
  parseAuthorizationInput,
  startCallbackServer,
  type AnthropicOAuthCredentials,
  type AuthCode,
  type CallbackServer,
} from "./anthropic-oauth";

// Provider login (moved from the VS Code extension's ChronosPanel.promptLogin /
// loginAnthropicSubscription). Electron-free: the browser opener and status
// sink are injected. Never log key or token values.

// Providers offered by the login dialog → the env var pi reads the key from
// (see pi-ai env-api-keys). "Other" lets the user name any other var.
export const PROVIDERS: { label: string; envVar: string }[] = [
  { label: "Anthropic (Claude)", envVar: "ANTHROPIC_API_KEY" },
  { label: "Google (Gemini)", envVar: "GEMINI_API_KEY" },
  { label: "OpenAI", envVar: "OPENAI_API_KEY" },
  { label: "OpenRouter", envVar: "OPENROUTER_API_KEY" },
  { label: "xAI (Grok)", envVar: "XAI_API_KEY" },
  { label: "Groq", envVar: "GROQ_API_KEY" },
  { label: "Mistral", envVar: "MISTRAL_API_KEY" },
  { label: "DeepSeek", envVar: "DEEPSEEK_API_KEY" },
];

export interface ProviderChoice {
  id: string;
  label: string;
  envVar: string;
}

/** Providers for the login dialog: slug ids (first word of the label) plus an `other` entry. */
export function providerChoices(): ProviderChoice[] {
  return [
    ...PROVIDERS.map((p) => ({ id: p.label.split(/\s/)[0].toLowerCase(), label: p.label, envVar: p.envVar })),
    { id: "other", label: "Other provider — enter the env var name", envVar: "" },
  ];
}

const ENV_VAR_RE = /^[A-Z][A-Z0-9_]*$/;

/** Persist a provider API key to `<workspace>/.chronos/.env` (mode 0600). */
export function saveApiKey(workspaceDir: string, envVar: string, key: string): void {
  if (!ENV_VAR_RE.test(envVar)) throw new Error(`Invalid environment variable name: ${JSON.stringify(envVar)}`);
  if (!key || /[\r\n]/.test(key)) throw new Error("The API key must be non-empty and on a single line.");
  upsertEnvVar(join(workspaceDir, ".chronos", ".env"), envVar, key);
}

/**
 * Write an Anthropic OAuth credential into pi's auth store (`<authDir>/auth.json`),
 * merging with any existing providers. Same file/shape pi's own /login writes.
 */
export function writeAuthStore(authDir: string, creds: AnthropicOAuthCredentials): void {
  const authPath = join(authDir, "auth.json");
  let store: Record<string, unknown> = {};
  if (existsSync(authPath)) {
    try {
      const parsed = JSON.parse(readFileSync(authPath, "utf-8"));
      if (parsed && typeof parsed === "object") store = parsed as Record<string, unknown>;
    } catch {
      store = {};
    }
  }
  store.anthropic = { type: "oauth", refresh: creds.refresh, access: creds.access, expires: creds.expires };
  // Owner-only dir + file (long-lived OAuth tokens). writeFileSync's mode only
  // applies on creation, so chmod too in case auth.json pre-exists looser.
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  writeFileSync(authPath, JSON.stringify(store, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(authPath, 0o600);
  } catch {
    /* best-effort */
  }
}

export type OauthStatus = { status: "waiting" | "done" | "error"; message?: string };

export interface AnthropicOauthOptions {
  /** pi's agent dir (PI_CODING_AGENT_DIR); auth.json is written here. */
  authDir: string;
  openExternal: (url: string) => void; // may return a promise; awaited
  onStatus: (s: OauthStatus) => void;
  /** Token exchange (injectable for tests). */
  exchange?: typeof completeAnthropicLogin;
  /** Browser-redirect wait (injectable for tests); defaults to the localhost callback server. */
  waitForCode?: () => Promise<AuthCode | undefined>;
}

// The single in-flight OAuth flow (one main window), so the renderer's manual
// code paste and cancel can reach it.
let pending: { submit(input: string): void; cancel(): void } | null = null;

/** Manual-paste fallback: feed a pasted code / "code#state" / redirect URL to the pending flow. */
export function submitAnthropicOauthCode(input: string): void {
  pending?.submit(input);
}

/** Abort a pending OAuth wait (closes the callback server). No-op otherwise. */
export function cancelAnthropicOauth(): void {
  pending?.cancel();
}

/**
 * Anthropic subscription (Claude Pro/Max) login: open the browser, capture the
 * redirect on the localhost callback (or a pasted code), exchange it for
 * tokens, and write `<authDir>/auth.json`. Errors are reported via onStatus and rethrown.
 */
export async function startAnthropicOauth(opts: AnthropicOauthOptions): Promise<void> {
  cancelAnthropicOauth(); // supersede any earlier flow
  const exchange = opts.exchange ?? completeAnthropicLogin;
  let server: CallbackServer | undefined;
  let mine: typeof pending = null;
  try {
    const { authUrl, verifier } = await beginAnthropicLogin();

    let settle: (v: AuthCode | undefined) => void = () => {};
    const manual = new Promise<AuthCode | undefined>((r) => (settle = r));
    mine = {
      submit: (input) => {
        const parsed = parseAuthorizationInput(input);
        if (!parsed.code) {
          opts.onStatus({ status: "waiting", message: "No authorization code found in the pasted value." });
          return;
        }
        settle({ code: parsed.code, state: parsed.state });
      },
      cancel: () => settle(undefined),
    };
    pending = mine;

    let waitForCode = opts.waitForCode;
    if (!waitForCode) {
      try {
        server = await startCallbackServer();
        waitForCode = server.waitForCode;
      } catch {
        server = undefined; // port unavailable → manual code entry only
      }
    }

    opts.onStatus({
      status: "waiting",
      message: server || opts.waitForCode
        ? "Approve access in your browser — you'll return here automatically, or paste the code."
        : "Approve access in your browser, then paste the code.",
    });
    await opts.openExternal(authUrl);

    const waits: Promise<AuthCode | undefined>[] = [manual];
    if (waitForCode) waits.push(waitForCode());
    const codeRes = await Promise.race(waits);
    if (!codeRes) throw new Error("Sign-in cancelled.");
    if (codeRes.state && codeRes.state !== verifier) throw new Error("OAuth state mismatch — please retry the sign-in.");

    const creds = await exchange({ code: codeRes.code, state: codeRes.state ?? verifier, verifier });
    writeAuthStore(opts.authDir, creds);
    opts.onStatus({ status: "done", message: "Connected to Claude (Pro/Max)." });
  } catch (err) {
    opts.onStatus({ status: "error", message: (err as Error).message });
    throw err;
  } finally {
    server?.close();
    if (pending === mine) pending = null;
  }
}
