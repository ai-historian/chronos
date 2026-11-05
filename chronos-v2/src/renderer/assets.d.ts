// esbuild inlines imported PNGs as data: URLs (see esbuild.mjs `.png` loader).
declare module "*.png" {
  const url: string;
  export default url;
}
