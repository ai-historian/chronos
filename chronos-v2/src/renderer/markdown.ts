import { marked } from "marked";
import DOMPurify from "dompurify";

// Same link grammar as the terminal-link provider:
// [view p.N], [view p.N#sel=x,y,w,h], [view p.N@sourcePath]
const VIEW_LINK_RE = /^\[view p\.(\d+)(?:#sel=([\d.]+),([\d.]+),([\d.]+),([\d.]+))?(?:@([^\]]+))?\]/;

const viewLinkExtension = {
  name: "viewLink",
  level: "inline" as const,
  start(src: string) {
    return src.indexOf("[view p.");
  },
  tokenizer(src: string) {
    const match = VIEW_LINK_RE.exec(src);
    if (!match) return undefined;
    return {
      type: "viewLink",
      raw: match[0],
      page: match[1],
      bbox: match[2] ? `${match[2]},${match[3]},${match[4]},${match[5]}` : "",
      src: match[6] ?? "",
    };
  },
  renderer(token: any) {
    const bboxAttr = token.bbox ? ` data-bbox="${token.bbox}"` : "";
    const srcAttr = token.src ? ` data-src="${encodeURIComponent(token.src)}"` : "";
    const sel = token.bbox ? " view-link-has-sel" : "";
    return `<a class="view-link${sel}" href="#" data-page="${token.page}"${bboxAttr}${srcAttr}>p. ${token.page}</a>`;
  },
};

marked.use({ extensions: [viewLinkExtension] });
marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html);
}

export interface ViewLinkData {
  pageId: number;
  bbox: { x: number; y: number; w: number; h: number } | null;
  sourcePath?: string;
}

/** Extract link data from a rendered .view-link anchor. */
export function parseViewLinkElement(el: HTMLElement): ViewLinkData | undefined {
  const page = parseInt(el.dataset.page ?? "", 10);
  if (isNaN(page)) return undefined;
  let bbox: ViewLinkData["bbox"] = null;
  if (el.dataset.bbox) {
    const [x, y, w, h] = el.dataset.bbox.split(",").map(parseFloat);
    if ([x, y, w, h].every((v) => !isNaN(v))) bbox = { x, y, w, h };
  }
  return {
    pageId: page,
    bbox,
    sourcePath: el.dataset.src ? decodeURIComponent(el.dataset.src) : undefined,
  };
}
