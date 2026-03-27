/**
 * Shared mutable source context.
 * Passed to all source-specific tools so that `change_source` can
 * redirect them at runtime without recreating the session.
 */
export interface SourceContext {
  sourceDir: string | null;
  sourceName: string | null;
  /** Output directory for this source: <dataDir>/data/<sourceName>/ */
  sourceDataDir: string | null;
}

export function createSourceContext(
  sourceDir?: string | null,
  sourceName?: string | null,
  sourceDataDir?: string | null,
): SourceContext {
  return {
    sourceDir: sourceDir ?? null,
    sourceName: sourceName ?? null,
    sourceDataDir: sourceDataDir ?? null,
  };
}

/**
 * Returns `ctx.sourceDir` or throws a clear error when no source is active.
 * Call at the top of every source-specific tool's `execute()`.
 */
export function requireSource(ctx: SourceContext): string {
  if (!ctx.sourceDir) {
    throw new Error("No source selected. Use the change_source tool first.");
  }
  return ctx.sourceDir;
}

/**
 * Returns `ctx.sourceDataDir` or throws a clear error when no source is active.
 * Call in tools that write output files.
 */
export function requireSourceDataDir(ctx: SourceContext): string {
  if (!ctx.sourceDataDir) {
    throw new Error("No source selected. Use the change_source tool first.");
  }
  return ctx.sourceDataDir;
}
