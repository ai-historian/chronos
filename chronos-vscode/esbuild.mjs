import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: {
    extension: "src/extension.ts",
    "pdf-worker": "src/pdf-worker.ts",
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

if (watch) {
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("Build complete.");
}
