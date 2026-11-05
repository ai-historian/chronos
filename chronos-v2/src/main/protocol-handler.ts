import { lstatSync, realpathSync, statSync } from "node:fs";
import { resolve, sep, dirname, basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEME = "chronos-file";

/**
 * realpath the deepest existing ancestor, then re-append the rest (so symlinked parents of
 * not-yet-existing files are caught). Returns null for a dangling symlink.
 */
function realish(p: string): string | null {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    // fall through: either missing or dangling
  }
  try {
    lstatSync(abs);
    return null; // exists as a link but target is missing: dangling
  } catch {
    // genuinely absent
  }
  const parent = dirname(abs);
  if (parent === abs) return abs;
  const rp = realish(parent);
  return rp === null ? null : join(rp, basename(abs));
}

function inside(r: string, c: string): boolean {
  if (c === r) return true;
  return c.startsWith(r.endsWith(sep) ? r : r + sep);
}

export function isAllowedPath(root: string, candidate: string): boolean {
  const r = realish(root);
  const c = realish(candidate);
  return r !== null && c !== null && inside(r, c);
}

/**
 * Returns the realpath-resolved regular file for `candidate` if it lies inside any root, else null.
 * The caller must serve the returned path (not the original) so check and use cannot diverge.
 */
export function resolveAllowedPath(roots: string[], candidate: string): string | null {
  let real: string;
  try {
    real = realpathSync(resolve(candidate));
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  for (const root of roots) {
    const r = realish(root);
    if (r !== null && inside(r, real)) return real;
  }
  return null;
}

/**
 * URLs use a fixed host ("local"): with `standard: true` Chromium parses the first path segment of
 * chronos-file:///Users/x as a lowercased host, so the host is never used to carry path data.
 */
export function toChronosFileUrl(absPath: string): string {
  const segs = absPath.replace(/\\/g, "/").split("/").filter((s) => s.length > 0);
  return `${SCHEME}://local/` + segs.map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s))).join("/");
}

/** Inverse of toChronosFileUrl; ignores the host entirely and rebuilds the path from pathname segments. */
export function fromChronosFileUrl(url: string, platform: NodeJS.Platform = process.platform): string {
  const segs = new URL(url).pathname.split("/").filter((s) => s.length > 0).map((s) => decodeURIComponent(s));
  if (platform === "win32") return segs.join("\\");
  return "/" + segs.join("/");
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
    const real = resolveAllowedPath(getRoots(), p);
    if (real === null) {
      console.warn(`[chronos] chronos-file 403: ${p}`);
      return new Response(null, { status: 403 });
    }
    return net.fetch(pathToFileURL(real).toString());
  });
}
