import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

const nodeCtx = await esbuild.context({
  entryPoints: {
    main: "src/main/main.ts",
    preload: "src/preload/preload.ts",
    "pdf-worker": "src/main/import/pdf-worker.ts",
    "pdf-split-worker": "src/main/import/pdf-split-worker.ts",
  },
  bundle: true,
  outdir: "out",
  format: "cjs",
  platform: "node",
  target: "node22",
  external: ["electron", "mupdf"],
  sourcemap: true,
  minify: false,
});

const rendererCtx = await esbuild.context({
  entryPoints: {
    "renderer/main": "src/renderer/main.ts",
    "renderer/welcome": "src/renderer/welcome.ts",
  },
  bundle: true,
  outdir: "out",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  minify: false,
  loader: { ".woff2": "file", ".png": "dataurl" },
  assetNames: "renderer/[name]",
});

function copyHtml() {
  mkdirSync("out/renderer", { recursive: true });
  for (const f of readdirSync("src/renderer").filter((n) => n.endsWith(".html")))
    cpSync(`src/renderer/${f}`, `out/renderer/${f}`);
}

if (watch) {
  copyHtml();
  await Promise.all([nodeCtx.watch(), rendererCtx.watch()]);
  console.log("Watching for changes...");
} else {
  await Promise.all([nodeCtx.rebuild(), rendererCtx.rebuild()]);
  copyHtml();
  await Promise.all([nodeCtx.dispose(), rendererCtx.dispose()]);
  console.log("Build complete.");
}
