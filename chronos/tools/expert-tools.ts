/**
 * Tools the vision-expert subagents (task / task_batch) can call during a turn.
 *
 * Experts run an agentic loop in `runExpertTurn`: they receive the page image
 * the orchestrator chose, then may self-direct — zoom into a sub-region they
 * only identify after seeing the page (`view_region`), or pull in another page
 * from the same source (`view_page`). Both reuse the existing crop/read paths,
 * so a tool result is just another image block appended to the conversation.
 *
 * The `Tool` shape pi-ai consumes is only `{ name, description, parameters }` —
 * execution is the caller's job, handled by `executeExpertTool` below.
 */
import { Type } from "@sinclair/typebox";
import type { ImageContent, TextContent, Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { Bbox } from "../utils/crop-image.js";
import { pageImageContent } from "./expert-turn.js";

const bboxSchema = Type.Object({
  x: Type.Number({ minimum: 0, maximum: 1 }),
  y: Type.Number({ minimum: 0, maximum: 1 }),
  w: Type.Number({ minimum: 0, maximum: 1 }),
  h: Type.Number({ minimum: 0, maximum: 1 }),
});

/** Tool definitions handed to `complete()` so the expert can request more imagery. */
export const EXPERT_TOOLS: Tool[] = [
  {
    name: "view_region",
    description:
      "Zoom into a sub-region of a page at full resolution. Use this to read dense tables, " +
      "marginalia, or faint/damaged ink that is too small in the full-page view. bbox is the " +
      "crop in normalized coordinates (0–1): x/y is the top-left corner, w/h is width/height. " +
      "page_id is optional — omit it to zoom into the page you are currently looking at.",
    parameters: Type.Object({
      bbox: bboxSchema,
      page_id: Type.Optional(
        Type.Number({ description: "Page to crop (file-system index). Omit to use the current page." }),
      ),
    }),
  },
  {
    name: "view_page",
    description:
      "Load another full page from the same source into the conversation — e.g. to compare with a " +
      "neighbouring page or follow a record that continues overleaf. page_id is the file-system index " +
      "(1 = page_0001.png), not the printed page number.",
    parameters: Type.Object({
      page_id: Type.Number({ description: "Page to load (file-system index)." }),
    }),
  },
];

/** Provenance of an image returned by a tool, so persistence can re-crop it from disk on restore. */
export interface ExpertToolImageRef {
  pageId: number;
  bbox?: Bbox;
  sourceDir: string;
}

/** A tool result captured for persistence: text plus an optional re-hydratable image. */
export interface PersistedToolResult {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text: string;
  image?: ExpertToolImageRef;
}

export interface ExpertToolOutcome {
  message: ToolResultMessage;
  persist: PersistedToolResult;
  /** Page the expert is now looking at, so a later view_region can default to it. */
  viewedPageId?: number;
}

function coerceBbox(value: unknown): Bbox | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (["x", "y", "w", "h"].every((k) => typeof o[k] === "number")) {
    return { x: o.x as number, y: o.y as number, w: o.w as number, h: o.h as number };
  }
  return null;
}

/**
 * Execute one expert tool call against the current source. Never throws: a bad
 * bbox / missing page / absent source comes back as an `isError` tool result so
 * the loop can feed it to the model and let it recover (and count toward the cap).
 */
export async function executeExpertTool(
  call: ToolCall,
  ctx: { sourceDir: string | undefined; currentPageId: number | null },
): Promise<ExpertToolOutcome> {
  const base = {
    role: "toolResult" as const,
    toolCallId: call.id,
    toolName: call.name,
    timestamp: Date.now(),
  };
  const fail = (text: string): ExpertToolOutcome => ({
    message: { ...base, content: [{ type: "text", text }], isError: true },
    persist: { toolCallId: call.id, toolName: call.name, isError: true, text },
  });

  if (!ctx.sourceDir) return fail("No source is active, so page imagery cannot be loaded.");

  if (call.name === "view_page" || call.name === "view_region") {
    const isRegion = call.name === "view_region";
    let bbox: Bbox | undefined;
    if (isRegion) {
      const parsed = coerceBbox(call.arguments?.bbox);
      if (!parsed) return fail("view_region requires bbox as { x, y, w, h }, each normalized 0–1.");
      bbox = parsed;
    }
    const rawPage = call.arguments?.page_id;
    const pageId =
      rawPage !== undefined && rawPage !== null ? Math.round(Number(rawPage)) : ctx.currentPageId;
    if (pageId === null || !Number.isFinite(pageId)) {
      return fail(`${call.name} needs a page_id (no page is currently in view).`);
    }
    try {
      const image: ImageContent = await pageImageContent(ctx.sourceDir, pageId, bbox);
      const text = isRegion
        ? `Zoomed into the requested region of page ${pageId}.`
        : `Loaded page ${pageId}.`;
      const content: (ImageContent | TextContent)[] = [image, { type: "text", text }];
      return {
        message: { ...base, content, isError: false },
        persist: {
          toolCallId: call.id,
          toolName: call.name,
          isError: false,
          text,
          image: { pageId, bbox, sourceDir: ctx.sourceDir },
        },
        viewedPageId: pageId,
      };
    } catch (e) {
      return fail((e as Error).message);
    }
  }

  return fail(`Unknown tool "${call.name}".`);
}

/** Rebuild a persisted tool result on session restore, re-cropping its image from disk. */
export async function rehydrateToolResult(tr: PersistedToolResult): Promise<ToolResultMessage> {
  const content: (ImageContent | TextContent)[] = [];
  if (tr.image) {
    try {
      content.push(await pageImageContent(tr.image.sourceDir, tr.image.pageId, tr.image.bbox));
    } catch {
      // page/source no longer on disk — restore text-only
    }
  }
  content.push({ type: "text", text: tr.text });
  return {
    role: "toolResult",
    toolCallId: tr.toolCallId,
    toolName: tr.toolName,
    content,
    isError: tr.isError,
    timestamp: Date.now(),
  };
}
