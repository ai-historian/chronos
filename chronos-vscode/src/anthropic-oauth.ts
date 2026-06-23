// Anthropic (Claude Pro/Max) subscription login — OAuth authorization-code + PKCE.
//
// Kept self-contained so the extension has no runtime dependency on the pi
// packages (same rationale as src/rpc/rpc-types.ts). The constants below are
// copied verbatim from pi-ai's Anthropic OAuth provider
// (@…/pi-ai/dist/utils/oauth/anthropic.js) and MUST stay in sync with the
// installed pi: the credential we write to ~/.pi/agent/auth.json is read and
// refreshed by pi using the same CLIENT_ID, scopes, and token endpoint.
import { createServer } from "node:http";

// atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl")
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export interface AnthropicOAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
}

export interface AuthCode {
  code: string;
  state?: string;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64url(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** Build the authorize URL and the PKCE verifier (which doubles as the OAuth `state`). */
export async function beginAnthropicLogin(): Promise<{ authUrl: string; verifier: string }> {
  const { verifier, challenge } = await generatePkce();
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });
  return { authUrl: `${AUTHORIZE_URL}?${params.toString()}`, verifier };
}

export interface CallbackServer {
  /** Resolves with the browser-redirect code/state, or undefined once cancel() is called. */
  waitForCode(): Promise<AuthCode | undefined>;
  cancel(): void;
  close(): void;
}

const SUCCESS_HTML =
  "<!doctype html><meta charset=utf-8><body style='font-family:system-ui,sans-serif;padding:3rem;text-align:center'>" +
  "<h2>Signed in to Claude ✓</h2><p>You can close this tab and return to VS Code.</p></body>";
const FAIL_HTML =
  "<!doctype html><meta charset=utf-8><body style='font-family:system-ui,sans-serif;padding:3rem;text-align:center'>" +
  "<h2>Login failed</h2><p>No authorization code was returned. Return to VS Code and try again.</p></body>";

/**
 * Start the localhost callback server pi's redirect_uri points at. Rejects if
 * the port is unavailable (the caller then falls back to manual code entry).
 */
export function startCallbackServer(): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let settle: (v: AuthCode | undefined) => void = () => {};
    const waitPromise = new Promise<AuthCode | undefined>((r) => {
      settle = r;
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url || "", `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code") ?? undefined;
      const state = url.searchParams.get("state") ?? undefined;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(code ? SUCCESS_HTML : FAIL_HTML);
      if (code) settle({ code, state });
    });
    server.once("error", reject);
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      resolve({
        waitForCode: () => waitPromise,
        cancel: () => settle(undefined),
        close: () => server.close(),
      });
    });
  });
}

/** Parse a pasted authorization code, a "code#state" pair, or a full redirect URL. */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
  }
  return { code: value };
}

/** Exchange the authorization code for OAuth tokens — the credential pi stores in auth.json. */
export async function completeAnthropicLogin(args: {
  code: string;
  state: string;
  verifier: string;
}): Promise<AnthropicOAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: args.code,
      state: args.state,
      redirect_uri: REDIRECT_URI,
      code_verifier: args.verifier,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token exchange failed (HTTP ${response.status}): ${text}`);
  }
  const data = JSON.parse(text) as { access_token: string; refresh_token: string; expires_in: number };
  if (!data.access_token || !data.refresh_token) {
    throw new Error("Token exchange returned no tokens.");
  }
  // Mirror pi's 5-minute safety margin on expiry.
  return {
    refresh: data.refresh_token,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}
