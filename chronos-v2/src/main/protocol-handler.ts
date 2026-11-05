import { existsSync, realpathSync } from "node:fs";
import { resolve, sep, dirname, basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEME = "chronos-file";

/** realpath the deepest existing ancestor, then re-append the rest (so symlinked parents are caught for not-yet-existing files). */
function realish(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(realish(parent), basename(abs));
}

export function isAllowedPath(root: string, candidate: string): boolean {
  const r = realish(root);
  const c = realish(candidate);
  if (c === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return c.startsWith(prefix);
}

export function toChronosFileUrl(absPath: string): string {
  const segs = absPath.replace(/\\/g, "/").split("/").filter((s) => s.length > 0);
  return `${SCHEME}:///` + segs.map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s))).join("/");
}

export function fromChronosFileUrl(url: string): string {
  const u = new URL(url);
  // Tolerate both chronos-file:///path (empty host) and chronos-file://host/path (host is the first segment).
  const raw = (u.host ? "/" + u.host : "") + u.pathname;
  const decoded = raw.split("/").map((s) => decodeURIComponent(s)).join("/");
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

/** Must be called before app.whenReady(). Electron is required lazily so the pure helpers are testable under plain Node. */
export function registerChronosFileScheme(): void {
  const { protocol } = require("electron") as typeof import("electron");
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

/** Call after app is ready. Serves files only from within `getRoots()`. */
export function installChronosFileHandler(getRoots: () => string[]): void {
  const { protocol, net } = require("electron") as typeof import("electron");
  protocol.handle(SCHEME, async (req) => {
    let p: string;
    try {
      p = fromChronosFileUrl(req.url);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!getRoots().some((r) => isAllowedPath(r, p))) {
      console.warn(`[chronos] chronos-file 403: ${p}`);
      return new Response(null, { status: 403 });
    }
    return net.fetch(pathToFileURL(p).toString());
  });
}
