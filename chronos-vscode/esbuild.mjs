import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const extensionCtx = await esbuild.context({
  entryPoints: {
    extension: "src/extension.ts",
    "pdf-worker": "src/pdf-worker.ts",
    "pdf-split-worker": "src/pdf-split-worker.ts",
  },
  bundle: true,
  outdir: "out",
  format: "cjs",
  platform: "node",
  target: "node18",
  external: ["vscode", "mupdf"],
  sourcemap: true,
  minify: false,
});

const webviewCtx = await esbuild.context({
  entryPoints: {
    "webview/main": "webview/main.ts",
  },
  bundle: true,
  outdir: "out",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  minify: false,
  loader: { ".woff2": "file", ".png": "dataurl" },
  assetNames: "webview/[name]",
});

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  console.log("Watching for changes...");
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
  console.log("Build complete.");
}
