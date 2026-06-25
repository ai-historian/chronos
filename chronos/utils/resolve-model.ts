import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

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
function modelCost(m: Model<Api>): number {
  // Custom/backend providers may register models without a cost; treat as free
  // so the comparator never throws on `.input`/`.output` of an absent cost.
  return (m.cost?.input ?? 0) + (m.cost?.output ?? 0);
}

export function pickCheapestModelSpec(registry: ModelRegistry): string | undefined {
  const models = registry.getAvailable();
  if (models.length === 0) return undefined;
  const cheapest = [...models].sort((a, b) => modelCost(a) - modelCost(b))[0];
  return `${cheapest.provider}/${cheapest.id}`;
}

/**
 * Small, current model tier to prefer for cheap throwaway helper calls (e.g.
 * session-name summarisation), keyed by the orchestrator's provider. The
 * registry also lists decommissioned models (e.g. retired claude-3-* ids) and
 * ranks them cheapest, so "cheapest overall" alone picks a model that 404s at
 * call time — prefer the provider's current small tier instead.
 */
const HELPER_FAMILIES: { match: (provider: string) => boolean; family: RegExp }[] = [
  { match: (p) => p.includes("anthropic"), family: /haiku/i },
  { match: (p) => p.includes("google") || p.includes("gemini") || p.includes("vertex"), family: /flash/i },
  { match: (p) => p.includes("openai") || p.includes("azure"), family: /nano/i },
];

// A model's headline version, parsed from its display name (e.g. "Claude Haiku
// 4.5" -> 4.05, "GPT-5.4 nano" -> 5.04), used to pick the newest — and thus
// still-served — model in a family. Returns -1 when no version is present.
function modelVersion(model: Model<Api>): number {
  const m = (model.name ?? model.id).match(/(\d+)(?:\.(\d+))?/);
  if (!m) return -1;
  return Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0);
}

// The newest available model in `family` for `provider`, or undefined if none.
function latestFamilyModel(models: Model<Api>[], provider: string, family: RegExp): Model<Api> | undefined {
  const candidates = models.filter((m) => m.provider === provider && family.test(m.id));
  if (candidates.length === 0) return undefined;
  // A rolling "*-latest" alias has no version digit (so it would sort last by
  // version) but is always the currently-served model — prefer it outright,
  // then the highest explicit version, then the cheaper id.
  const isLatestAlias = (m: Model<Api>) => (/latest/i.test(`${m.name ?? ""} ${m.id}`) ? 0 : 1);
  return candidates.sort((a, b) => {
    if (isLatestAlias(a) !== isLatestAlias(b)) return isLatestAlias(a) - isLatestAlias(b);
    const dv = modelVersion(b) - modelVersion(a);
    if (dv !== 0) return dv;
    return modelCost(a) - modelCost(b);
  })[0];
}

/**
 * Ordered, deduped candidate specs for a cheap throwaway helper call, best-first:
 *   1. the orchestrator provider's current small tier (anthropic → latest Haiku,
 *      google → latest Flash, openai → latest Nano);
 *   2. any auth'd small-tier model (haiku/flash/nano) from any provider — these
 *      are current/served, so they cover the no-orchestrator path and providers
 *      with no family match without falling back to a possibly-retired model;
 *   3. the cheapest model pi has auth for (the registry lists retired models and
 *      ranks them cheapest, so this can 404 — last resort);
 *   4. the orchestrator's own current model (guaranteed callable).
 * The caller tries each in order until one succeeds, so a retired/blocked model
 * is skipped rather than failing the call outright.
 */
export function helperModelCandidates(
  registry: ModelRegistry,
  orchestrator?: { provider: string; id: string },
): string[] {
  const available = registry.getAvailable();
  const specs: string[] = [];
  const add = (spec: string | undefined) => {
    if (spec && !specs.includes(spec)) specs.push(spec);
  };
  const familyBest = (provider: string, family: RegExp) => {
    const m = latestFamilyModel(available, provider, family);
    if (m) add(`${m.provider}/${m.id}`);
  };

  // 1. The orchestrator provider's current small tier first.
  if (orchestrator) {
    const fam = HELPER_FAMILIES.find((f) => f.match(orchestrator.provider));
    if (fam) familyBest(orchestrator.provider, fam.family);
  }
  // 2. Any auth'd small-tier model from any provider (current/served).
  for (const fam of HELPER_FAMILIES) {
    const providers = new Set(available.filter((m) => fam.match(m.provider)).map((m) => m.provider));
    for (const p of providers) familyBest(p, fam.family);
  }
  // 3. Cheapest with auth (may be retired) and 4. the orchestrator's own model.
  add(pickCheapestModelSpec(registry));
  add(orchestrator ? `${orchestrator.provider}/${orchestrator.id}` : undefined);
  return specs;
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
