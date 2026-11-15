/**
 * DOM-free extraction of search results from a DuckDuckGo result page.
 *
 * DuckDuckGo's HTML (`/html/`) and lite (`/lite/`) endpoints both ship the same
 * two facts per hit: an anchor carrying the title and href, and a sibling
 * element carrying the snippet. The href is sometimes direct and sometimes a
 * redirect wrapper (`//duckduckgo.com/l/?uddg=<encoded target>`), so every href
 * goes through {@link resolveResultUrl}.
 *
 * This module has no imports on purpose: the plugin entry point imports the
 * harness (`@deepseek-ai/dsh-web`), which only resolves inside a dsh process,
 * while the parser must stay testable with a plain `node` process.
 */

/** One extracted hit, before it is narrowed to the harness source shape. */
export interface ParsedSearchSource {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
}

/** Named entities that appear in DuckDuckGo titles and snippets. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '\u2026',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

/** Decode the numeric and named HTML entities DuckDuckGo emits. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Collapse markup and whitespace in a title/snippet fragment into display text. */
export function cleanText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve one raw `href` into the destination it points at.
 *
 * @param href - the attribute value as written in the page (entities included).
 * @returns the absolute http(s) target, or undefined for a DuckDuckGo-internal,
 * ad, or non-http link (dropped rather than guessed).
 */
export function resolveResultUrl(href: string): string | undefined {
  const raw = decodeEntities(href).trim();
  if (raw.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw.startsWith('//') ? `https:${raw}` : raw, 'https://duckduckgo.com');
  } catch {
    return undefined;
  }
  if (/(^|\.)duckduckgo\.com$/i.test(parsed.hostname)) {
    // Redirect wrapper: the real target rides in `uddg`, already percent-decoded
    // by URLSearchParams. A wrapper without it is an ad or an internal link.
    const target = parsed.searchParams.get('uddg');
    if (target === null || target.length === 0) return undefined;
    return resolveResultUrl(target);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed.toString();
}

interface OpenTag {
  readonly name: string;
  readonly attributes: string;
  readonly start: number;
  /** Index just past this tag's `>`. */
  readonly end: number;
}

/** Read one attribute value from a raw tag attribute string (double or single quoted). */
function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(String.raw`\b${name}\s*=\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes);
  if (match === null) return undefined;
  return match[1] ?? match[2];
}

/** Whether a raw tag attribute string carries `token` in its class list. */
function hasClass(attributes: string, token: string): boolean {
  const value = attribute(attributes, 'class');
  if (value === undefined) return false;
  return value.split(/\s+/).includes(token);
}

/** Walk every open tag in document order. Not a full parser: DuckDuckGo's pages are tag-simple. */
function scanTags(html: string): OpenTag[] {
  const tags: OpenTag[] = [];
  const pattern = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    const name = match[1];
    const attributes = match[2];
    if (name === undefined || attributes === undefined) continue;
    tags.push({ name: name.toLowerCase(), attributes, start: match.index, end: match.index + match[0].length });
  }
  return tags;
}

/** The text between a tag's `>` and its matching close tag, when the close tag exists. */
function innerText(html: string, tag: OpenTag): string | undefined {
  const close = new RegExp(`</${tag.name}\\s*>`, 'i').exec(html.slice(tag.end));
  if (close === null) return undefined;
  return html.slice(tag.end, tag.end + close.index);
}

/**
 * Pair title anchors with the snippet that follows them.
 *
 * Pairing is positional rather than nested: a snippet belongs to the closest
 * preceding title anchor, which is how both DuckDuckGo layouts emit a hit.
 */
function extractResults(html: string, titleClass: string, snippetClass: string): ParsedSearchSource[] {
  const tags = scanTags(html);
  const titles = tags.filter((tag) => hasClass(tag.attributes, titleClass));
  const snippets = tags.filter((tag) => hasClass(tag.attributes, snippetClass));
  const sources: ParsedSearchSource[] = [];
  for (let index = 0; index < titles.length; index += 1) {
    const title = titles[index];
    if (title === undefined) continue;
    const href = attribute(title.attributes, 'href');
    const url = href === undefined ? undefined : resolveResultUrl(href);
    if (url === undefined) continue;
    const nextStart = titles[index + 1]?.start ?? Number.POSITIVE_INFINITY;
    const snippetTag = snippets.find((candidate) => candidate.start > title.end && candidate.start < nextStart);
    const rawTitle = innerText(html, title);
    const rawSnippet = snippetTag === undefined ? undefined : innerText(html, snippetTag);
    const titleText = rawTitle === undefined ? '' : cleanText(rawTitle);
    const snippetText = rawSnippet === undefined ? '' : cleanText(rawSnippet);
    sources.push({
      url,
      ...(titleText.length > 0 ? { title: titleText } : {}),
      ...(snippetText.length > 0 ? { snippet: snippetText } : {}),
    });
  }
  return sources;
}

/** Extract hits from a `html.duckduckgo.com/html/` response body. */
export function parseDuckDuckGoHtml(html: string): ParsedSearchSource[] {
  return extractResults(html, 'result__a', 'result__snippet');
}

/** Extract hits from a `lite.duckduckgo.com/lite/` response body. */
export function parseDuckDuckGoLite(html: string): ParsedSearchSource[] {
  return extractResults(html, 'result-link', 'result-snippet');
}