/**
 * Lightweight <head> parser — no extra dependencies.
 * Extracts tags in document order and produces the `ParsedHead` structure.
 */
import type { ParsedHead, HeadTag } from "../core";

/** Very simple attribute tokenizer: returns a lowercased map of attr=value pairs. */
function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // Match: name, name="value", name='value', name=value
  const re = /([a-z][a-z0-9\-_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=><`]+)))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    const name = m[1].toLowerCase();
    const val = (m[2] ?? m[3] ?? m[4] ?? "").toLowerCase();
    attrs[name] = val;
  }
  return attrs;
}

/**
 * Convert a head tag + its attrs to a normalized order token.
 * Returns null for tags that should be ignored in the order list.
 */
function toOrderToken(tag: string, attrs: Record<string, string>): string | null {
  switch (tag) {
    case "meta": {
      // meta[charset]
      if ("charset" in attrs) return "meta[charset]";
      // meta[name=viewport]
      if (attrs["name"] === "viewport") return "meta[viewport]";
      // meta[http-equiv], meta[property] etc — skip from order
      return null;
    }
    case "title":
      return "title";
    case "link": {
      const rel = (attrs["rel"] ?? "").toLowerCase();
      // Skip alternates / hreflang
      if (rel === "alternate" || rel === "alternate stylesheet") return null;
      if (rel === "stylesheet") return "link[stylesheet]";
      if (rel === "preload") return "link[preload]";
      if (rel === "preconnect") return "link[preconnect]";
      if (rel === "dns-prefetch") return "link[dns-prefetch]";
      if (rel === "modulepreload") return "link[modulepreload]";
      // Other link rels — still record in tags but skip from order
      return null;
    }
    case "style":
      return "style";
    case "script":
      return "script";
    case "base":
      return "base";
    default:
      return null;
  }
}

/**
 * Extract the raw `<head>...</head>` slice from HTML.
 * Returns empty string when not found.
 */
function extractHeadSlice(html: string): string {
  const start = html.search(/<head[\s>]/i);
  if (start === -1) return "";
  const end = html.search(/<\/head>/i);
  if (end === -1) return html.slice(start);
  return html.slice(start, end + "</head>".length);
}

/**
 * Parse the <head> of a raw HTML string into a ParsedHead object.
 * Uses regex/tokenizer — no external deps.
 */
export function parseHead(html: string): ParsedHead {
  const headSlice = extractHeadSlice(html);
  const tags: HeadTag[] = [];
  const order: string[] = [];

  if (!headSlice) return { order, tags };

  /**
   * Tokenize tags. We match:
   *  - <script ...> ... </script>  (with content)
   *  - <style ...> ... </style>    (with content)
   *  - Self-closing or void tags: <meta .../>, <link .../>, <base .../>
   *  - <title>...</title>
   * We skip comments and processing instructions.
   */
  // Combined regex for head tags
  const tagRe =
    /<(script|style|title|meta|link|base)((?:\s[^>]*)?)(?:\/>|>)([\s\S]*?(?=<\/\1>|$))?(?:<\/\1>)?/gi;

  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(headSlice)) !== null) {
    const tagName = m[1].toLowerCase();
    const attrStr = m[2] ?? "";
    const attrs = parseAttrs(attrStr);

    // For script/style/title, store content as special key
    const content = m[3];
    if (content !== undefined && content.trim()) {
      attrs["_content"] = content.trim().slice(0, 200); // store first 200 chars as hint
    }

    tags.push({ tag: tagName, attrs });

    const token = toOrderToken(tagName, attrs);
    if (token) {
      order.push(token);
    }
  }

  return { order, tags };
}
