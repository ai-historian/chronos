import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PROVIDERS,
  providerChoices,
  saveApiKey,
  startAnthropicOauth,
  submitAnthropicOauthCode,
  cancelAnthropicOauth,
} from "../src/main/login";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "chronos-login-"));
}

function stateOf(url: string): string {
  return new URL(url).searchParams.get("state") ?? "";
}

test("providerChoices lists PROVIDERS with slug ids plus other", () => {
  const choices = providerChoices();
  assert.equal(choices.length, PROVIDERS.length + 1);
  assert.deepEqual(choices[0], { id: "anthropic", label: "Anthropic (Claude)", envVar: "ANTHROPIC_API_KEY" });
  assert.equal(choices[1].id, "google");
  assert.equal(choices.at(-1)!.id, "other");
});

test("saveApiKey writes KEY to .chronos/.env mode 0600", () => {
  const ws = tmp();
  try {
    saveApiKey(ws, "ANTHROPIC_API_KEY", "sk-test");
    const p = join(ws, ".chronos", ".env");
    assert.equal(readFileSync(p, "utf-8"), "ANTHROPIC_API_KEY=sk-test\n");
    assert.equal(statSync(p).mode & 0o777, 0o600);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("saveApiKey rejects an invalid env var name and a key with a newline", () => {
  const ws = tmp();
  try {
    assert.throws(() => saveApiKey(ws, "bad-name", "k"));
    assert.throws(() => saveApiKey(ws, "lower_KEY", "k"));
    assert.throws(() => saveApiKey(ws, "OK_KEY", "a\nEVIL=1"));
    assert.throws(() => saveApiKey(ws, "OK_KEY", ""));
    assert.equal(existsSync(join(ws, ".chronos", ".env")), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("oauth writes auth.json under authDir", async () => {
  const root = tmp();
  const authDir = join(root, "pi-agent");
  try {
    // pre-existing provider entry is preserved
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "x" } }));
    const urls: string[] = [];
    const statuses: string[] = [];
    await startAnthropicOauth({
      authDir,
      openExternal: (u) => urls.push(u),
      onStatus: (s) => statuses.push(s.status),
      waitForCode: async () => ({ code: "abc", state: stateOf(urls[0]) }),
      exchange: async () => ({ refresh: "r", access: "a", expires: 123 }),
    });
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^https:\/\/claude\.ai\/oauth\/authorize\?/);
    const p = join(authDir, "auth.json");
    const store = JSON.parse(readFileSync(p, "utf-8"));
    assert.deepEqual(store.anthropic, { type: "oauth", refresh: "r", access: "a", expires: 123 });
    assert.deepEqual(store.openai, { type: "api_key", key: "x" });
    assert.equal(statSync(p).mode & 0o777, 0o600);
    assert.deepEqual(statuses, ["waiting", "done"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oauth manual code paste resolves the wait", async () => {
  const root = tmp();
  try {
    const urls: string[] = [];
    let exchanged: { code: string; state: string } | undefined;
    const flow = startAnthropicOauth({
      authDir: root,
      openExternal: (u) => urls.push(u),
      onStatus: () => {},
      waitForCode: () => new Promise(() => {}), // never redirects
      exchange: async (a) => {
        exchanged = { code: a.code, state: a.state };
        return { refresh: "r", access: "a", expires: 1 };
      },
    });
    while (!urls.length) await new Promise((r) => setTimeout(r, 5));
    submitAnthropicOauthCode(`pasted#${stateOf(urls[0])}`);
    await flow;
    assert.equal(exchanged?.code, "pasted");
    assert.ok(existsSync(join(root, "auth.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oauth cancel aborts the pending wait", async () => {
  const root = tmp();
  try {
    const urls: string[] = [];
    const statuses: string[] = [];
    const flow = startAnthropicOauth({
      authDir: root,
      openExternal: (u) => urls.push(u),
      onStatus: (s) => statuses.push(s.status),
      waitForCode: () => new Promise(() => {}),
      exchange: async () => ({ refresh: "r", access: "a", expires: 1 }),
    });
    while (!urls.length) await new Promise((r) => setTimeout(r, 5));
    cancelAnthropicOauth();
    await assert.rejects(flow, /cancel/i);
    assert.equal(existsSync(join(root, "auth.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oauth error reports status error", async () => {
  const root = tmp();
  try {
    const urls: string[] = [];
    const statuses: { status: string; message?: string }[] = [];
    await assert.rejects(
      startAnthropicOauth({
        authDir: root,
        openExternal: (u) => urls.push(u),
        onStatus: (s) => statuses.push(s),
        waitForCode: async () => ({ code: "abc", state: stateOf(urls[0]) }),
        exchange: async () => {
          throw new Error("Token exchange failed (HTTP 400)");
        },
      }),
      /Token exchange failed/,
    );
    assert.equal(statuses.at(-1)?.status, "error");
    assert.match(statuses.at(-1)?.message ?? "", /Token exchange failed/);
    assert.equal(existsSync(join(root, "auth.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
