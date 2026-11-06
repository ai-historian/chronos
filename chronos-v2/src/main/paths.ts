import { join } from "node:path";

// Where the bundled pi runtime and the chronos agent live. Packaged builds ship
// them under resources/vendor/ (populated by scripts/bundle-agent.mjs); in dev
// we run the devDependency pi and the sibling ../chronos working copy.

export interface VendorPaths {
  piCli: string;
  agentDir: string;
}

export function resolveVendorPaths(opts: { isPackaged: boolean; resourcesPath: string; appRoot: string }): VendorPaths {
  if (opts.isPackaged) {
    return {
      piCli: join(opts.resourcesPath, "vendor", "pi", "dist", "bundle", "cli.js"),
      agentDir: join(opts.resourcesPath, "vendor", "chronos"),
    };
  }
  return {
    piCli: join(opts.appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
    agentDir: join(opts.appRoot, "..", "chronos"),
  };
}

/**
 * Packaged builds keep main.js inside app.asar, but worker scripts (and the
 * mupdf they import) are asarUnpack'ed to app.asar.unpacked/ — a Worker cannot
 * load from inside an asar. Maps `.../app.asar/...` to `.../app.asar.unpacked/...`;
 * any other path is returned unchanged.
 */
export function unpackedPath(p: string): string {
  return p.replace(/([\\/])app\.asar(?=[\\/])/, "$1app.asar.unpacked");
}
