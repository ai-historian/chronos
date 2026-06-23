import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

export type ResolvedModel =
  | { ok: true; model: Model<Api>; apiKey: string | undefined; headers?: Record<string, string> }
  | { ok: false; error: string };

/**
 * Resolve request auth across pi versions: older registries expose
 * `getApiKey(model)`, newer ones `getApiKeyAndHeaders(model)` (which also
 * supports header-based auth where apiKey may legitimately be undefined).
 */
async function resolveAuth(
  registry: ModelRegistry,
  model: Model<Api>,
): Promise<{ apiKey?: string; headers?: Record<string, string> } | { error: string }> {
  const reg = registry as any;
  if (typeof reg.getApiKeyAndHeaders === "function") {
    const auth = await reg.getApiKeyAndHeaders(model);
    if (!auth.ok) return { error: auth.error };
    return { apiKey: auth.apiKey, headers: auth.headers };
  }
  const apiKey = await reg.getApiKey(model);
  if (!apiKey) return { error: `No API key configured for ${model.provider}/${model.id}.` };
  return { apiKey };
}

/**
 * The cheapest model (by per-token input+output price) that pi has auth for,
 * as "provider/model-id", or undefined if none. Used for throwaway helper calls
 * like session-name summarisation — keep the cost negligible and provider-neutral.
 */
export function pickCheapestModelSpec(registry: ModelRegistry): string | undefined {
  const models = registry.getAvailable();
  if (models.length === 0) return undefined;
  const cheapest = [...models].sort(
    (a, b) => (a.cost.input + a.cost.output) - (b.cost.input + b.cost.output),
  )[0];
  return `${cheapest.provider}/${cheapest.id}`;
}

const MAX_LISTED_MODELS = 40;

function formatAvailable(registry: ModelRegistry, needsVision: boolean): string {
  const models = registry
    .getAvailable()
    .filter((m) => !needsVision || m.input.includes("image"))
    .map((m) => `${m.provider}/${m.id}`);
  if (models.length === 0) return "No models with configured auth found.";
  const shown = models.slice(0, MAX_LISTED_MODELS);
  const more = models.length - shown.length;
  return (
    `Available${needsVision ? " vision-capable" : ""} models:\n${shown.join("\n")}` +
    (more > 0 ? `\n…and ${more} more.` : "")
  );
}

/**
 * Resolve a model spec from the orchestrator into a pi model + API key.
 *
 * Accepts "provider/model-id" (e.g. "anthropic/claude-opus-4-8") or a bare
 * model id, which is matched across all providers (ambiguous → error).
 * `fallback` is used when no spec is given (e.g. the orchestrator's current
 * model); if neither is set, the caller is told to choose a model explicitly.
 * When `needsVision` is set (an image is being attached), the model must
 * support image input.
 */
export async function resolveExpertModel(
  spec: string | undefined,
  registry: ModelRegistry,
  fallback: string | undefined,
  needsVision: boolean,
): Promise<ResolvedModel> {
  const requested = (spec ?? fallback ?? "").trim();
  if (!requested) {
    return {
      ok: false,
      error: `No model specified and no default is available. Pass a model as provider/model-id.\n${formatAvailable(registry, needsVision)}`,
    };
  }

  let model: Model<Api> | undefined;
  const slash = requested.indexOf("/");
  if (slash > 0) {
    model = registry.find(requested.slice(0, slash), requested.slice(slash + 1));
  } else {
    const matches = registry.getAll().filter((m) => m.id === requested);
    if (matches.length > 1) {
      const names = matches.map((m) => `${m.provider}/${m.id}`).join(", ");
      return { ok: false, error: `Model id "${requested}" is ambiguous (${names}). Use provider/model-id.` };
    }
    model = matches[0];
  }

  if (!model) {
    return {
      ok: false,
      error: `Unknown model "${requested}". Use provider/model-id.\n${formatAvailable(registry, needsVision)}`,
    };
  }
  if (needsVision && !model.input.includes("image")) {
    return {
      ok: false,
      error: `Model ${model.provider}/${model.id} does not support image input.\n${formatAvailable(registry, true)}`,
    };
  }

  const auth = await resolveAuth(registry, model);
  if ("error" in auth) {
    return { ok: false, error: `${auth.error}\n${formatAvailable(registry, needsVision)}` };
  }

  return { ok: true, model, apiKey: auth.apiKey, headers: auth.headers };
}
