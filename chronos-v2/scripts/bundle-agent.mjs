#!/usr/bin/env node
// Populates chronos-v2/vendor/{pi,chronos} (gitignored) for packaging, and
// copies third-party licence texts into resources/licenses/.
//
// Chronos agent (the ../chronos pi-package):
//   1. (../chronos)      npm ci                         full install (typescript is a devDependency)
//   2. (../chronos)      npm run build                  tsc -> dist/
//   3. copy dist, prompts, skills (if any), package.json, package-lock.json -> vendor/chronos/
//   4. (vendor/chronos)  npm ci --omit=dev --omit=peer  prod-only tree: dotenv, sharp(+@img/*), @sinclair/typebox
// The prod install runs in the vendor copy, so ../chronos/node_modules is only
// ever a full dev tree and ../chronos always stays buildable.
// The pi peers are not vendored with the agent: pi's extension loader aliases
// @earendil-works/pi-{ai,coding-agent} to its own bundled copies.
//
// pi itself: the installed devDependency node_modules/@earendil-works/pi-coding-agent
// is copied whole (package.json, dist/ incl. dist/bundle/chunks/, node_modules/)
// after asserting its version equals package.json "piVersion".
//
// Usage: node scripts/bundle-agent.mjs

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentSrc = join(appRoot, "..", "chronos");
const vendor = join(appRoot, "vendor");
const licensesDir = join(appRoot, "resources", "licenses");
const piSrc = join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent");

const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));
const run = (cmd, cwd) => {
  console.log(`$ (${cwd}) ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
};

// --- pi runtime ---------------------------------------------------------
const piVersion = readJson(join(appRoot, "package.json")).piVersion;
const piPkg = readJson(join(piSrc, "package.json"));
if (piPkg.version !== piVersion) {
  throw new Error(`installed pi is ${piPkg.version}, package.json piVersion is ${piVersion} — run npm ci`);
}
const piDest = join(vendor, "pi");
rmSync(piDest, { recursive: true, force: true });
mkdirSync(piDest, { recursive: true });
for (const entry of ["package.json", "dist", "node_modules"]) {
  cpSync(join(piSrc, entry), join(piDest, entry), { recursive: true, dereference: true });
}
console.log(`vendored pi ${piPkg.version} -> ${piDest}`);

// --- chronos agent ------------------------------------------------------
const agentDest = join(vendor, "chronos");
rmSync(agentDest, { recursive: true, force: true });
mkdirSync(agentDest, { recursive: true });
run("npm ci", agentSrc);
run("npm run build", agentSrc);
for (const entry of ["dist", "prompts", "skills", "package.json", "package-lock.json"]) {
  if (existsSync(join(agentSrc, entry))) cpSync(join(agentSrc, entry), join(agentDest, entry), { recursive: true });
}
run("npm ci --omit=dev --omit=peer", agentDest);
console.log(`vendored chronos agent -> ${agentDest}`);

// --- licences -----------------------------------------------------------
mkdirSync(licensesDir, { recursive: true });
const copyLicense = (from, name) => {
  if (!existsSync(from)) throw new Error(`licence not found: ${from}`);
  cpSync(from, join(licensesDir, `${name}.txt`));
};

// pi's npm tarball ships no LICENSE file; fall back to the MIT text with the
// copyright holder from its package.json.
const piLicense = join(piSrc, "LICENSE");
if (existsSync(piLicense)) {
  copyLicense(piLicense, "pi-coding-agent");
} else {
  if (piPkg.license !== "MIT") throw new Error(`pi licence is ${piPkg.license}, expected MIT`);
  const header = `${piPkg.name} ${piPkg.version} — MIT per package.json; upstream: https://github.com/earendil-works/pi\n\n`;
  writeFileSync(join(licensesDir, "pi-coding-agent.txt"), header + mitText(piPkg.author));
}

const agentModules = join(agentDest, "node_modules");
copyLicense(join(agentModules, "sharp", "LICENSE"), "sharp");
const libvips = readdirSync(join(agentModules, "@img")).find((d) => d.startsWith("sharp-libvips-"));
if (!libvips) throw new Error("no @img/sharp-libvips-* prebuild in vendored agent");
// The libvips prebuilds (LGPL-3.0-or-later) ship no LICENSE file. The full
// LGPL-3.0 and GPL-3.0 texts are committed statically in resources/licenses/;
// the prebuild's README licence table is kept as a supplementary notice.
for (const name of ["LGPL-3.0.txt", "GPL-3.0.txt"]) {
  if (!existsSync(join(licensesDir, name))) throw new Error(`missing static licence text: resources/licenses/${name}`);
}
copyLicense(join(agentModules, "@img", libvips, "README.md"), "sharp-libvips-NOTICE");
copyLicense(join(appRoot, "node_modules", "mupdf", "LICENSE"), "mupdf");
console.log(`licences -> ${licensesDir}`);

function mitText(holder) {
  return `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}
