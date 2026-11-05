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
  `Chronos-<version>.AppImage` and `chronos_<version>_amd64.deb` on Linux,
  `Chronos-<version>-arm64.dmg` / `Chronos-<version>-x64.dmg` on macOS (`--mac --arm64` or
  `--mac --x64`, matching the build machine), an NSIS `Setup .exe` on Windows. `vendor/` and the licences ship under
  the app's `resources/`, outside the asar; the PDF import workers and `mupdf` are unpacked
  to `app.asar.unpacked/`.

**Native modules are per platform.** `vendor/chronos/node_modules` contains `sharp` with
the `@img/*` prebuilds for the machine that ran `bundle-agent`, so build each OS's
installer on that OS (CI does this: `.github/workflows/v2-release.yml`, triggered by a
`v2-*` tag). The same holds per CPU architecture: there is no universal macOS build, and
CI builds the arm64 dmg on `macos-latest` and the x64 dmg on `macos-13`. `bundle-agent`
has no target-platform switch yet.

**Signing** is electron-builder's default: it signs only when `CSC_LINK` (certificate
file/base64) and `CSC_KEY_PASSWORD` are set; otherwise builds are unsigned. macOS
notarization is off.
