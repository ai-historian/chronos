# Chronos (standalone app)

## Building installers

Prerequisites: Node 22+, and the sibling `../chronos` agent checkout (the bundler builds it).
Installers are built per OS on that OS — there is no cross-compilation.

```bash
npm ci
npm run dist            # = bundle-agent + build + electron-builder (targets for the current OS)
npm run dist -- --linux AppImage deb   # pick targets explicitly
```

- `npm run bundle-agent` fills the gitignored `vendor/` with the pi runtime and the built
  `../chronos` agent (production `node_modules`), and refreshes `resources/licenses/`.
- `npm run build` bundles the app into `out/` with esbuild.
- `electron-builder` (config in `electron-builder.yml`) writes the artefacts to `dist/`:
  `Chronos-<version>.AppImage` and `chronos-v2_<version>_amd64.deb` on Linux, a universal
  `.dmg` on macOS, an NSIS `Setup .exe` on Windows. `vendor/` and the licences ship under
  the app's `resources/`, outside the asar; the PDF import workers and `mupdf` are unpacked
  to `app.asar.unpacked/`.

**Native modules are per platform.** `vendor/chronos/node_modules` contains `sharp` with
the `@img/*` prebuilds for the machine that ran `bundle-agent`, so build each OS's
installer on that OS (CI does this: `.github/workflows/v2-release.yml`, triggered by a
`v2-*` tag). `bundle-agent` has no target-platform switch yet. The same applies to the
macOS universal `.dmg`: it carries only the build machine's `sharp` architecture.

**Signing** is electron-builder's default: it signs only when `CSC_LINK` (certificate
file/base64) and `CSC_KEY_PASSWORD` are set; otherwise builds are unsigned. macOS
notarization is off.
