// pi ≥0.84 moved `complete` to the `/compat` subpath in its type declarations,
// while its extension loader aliases both the root and `/compat` to the same
// module at runtime (pi 1.5.0: both resolve to `pi-ai-extension-view.js`, which
// re-exports `/compat` plus TypeBox's `Type`). Import the value from the root
// (works on 0.79 through 1.5) and borrow the type from `/compat`.
import * as piAi from "@earendil-works/pi-ai";
import type { complete as CompleteFn } from "@earendil-works/pi-ai/compat";
export const complete: typeof CompleteFn = (piAi as unknown as { complete: typeof CompleteFn }).complete;
