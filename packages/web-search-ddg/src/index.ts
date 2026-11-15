/**
 * DuckDuckGo search provider for the DeepSeek Harness web seam (`ctx.web`).
 *
 * Why this exists: every shipped search provider (DeepSeek official, the
 * DeepSeek Search API) needs `DEEPSEEK_API_KEY`. DuckDuckGo's HTML endpoints
 * take an anonymous POST/GET and return plain server-rendered results, so this
 * provider makes `web_search` work with no credential at all.
 *
 * Contract kept from the reference provider (`dsh-web-search-deepseek`):
 * `available()` is a local constant and never touches the network, `search()`
 * honours the caller's `AbortSignal`, results map onto the seam's
 * `WebSearchSource` fields without inventing any, and every failure is a typed
 * {@link WebError}. An unparseable page yields zero sources — never fabricated
 * ones.
 *
 * @module @operant/web-search-ddg
 */
import { WebError } from '@deepseek-ai/dsh-web';
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web';
import { parseDuckDuckGoHtml, parseDuckDuckGoLite } from './parse.js';
import type { ParsedSearchSource } from './parse.js';

/** Stable provider id this plugin registers under; pin it as `web.searchProvider`. */
export const DDG_PROVIDER_ID = 'duckduckgo';

const HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
const LITE_ENDPOINT = 'https://lite.duckduckgo.com/lite/';

/**
 * A current desktop-browser User-Agent. The HTML endpoints serve a bot challenge
 * to obvious clients, so this is deliberately not a `dsh/…` attribution string;
 * `accept-language` keeps results in English instead of a guessed locale.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Build the error the seam already knows how to route for caller cancellation. */
function abortedError(signal: AbortSignal | undefined, fallback: unknown): WebError {
  return new WebError('DuckDuckGo search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  });
}

/** True for a `fetch`/`AbortSignal` abort, which surfaces as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Throw the seam's cancellation error when the caller already cancelled. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortedError(signal, undefined);
}

/** Read one page body, mapping transport, cancellation, and HTTP failures. */
async function fetchPage(
  url: string,
  init: {
    readonly method: 'GET' | 'POST';
    readonly body?: string;
    readonly referer?: string;
  },
  signal: AbortSignal | undefined,
): Promise<string> {
  throwIfAborted(signal);
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
  };
  if (init.body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (init.referer !== undefined) headers['referer'] = init.referer;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: 'follow',
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error);
    throw new Error(`request to ${url} failed: ${String(error)}`, { cause: error });
  }
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  try {
    return await response.text();
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error);
    throw new Error(`reading ${url} failed: ${String(error)}`, { cause: error });
  }
}

/** Drop duplicate destinations while keeping the page's own ranking. */
function dedupe(sources: readonly ParsedSearchSource[]): ParsedSearchSource[] {
  const seen = new Set<string>();
  const unique: ParsedSearchSource[] = [];
  for (const source of sources) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    unique.push(source);
  }
  return unique;
}

/**
 * The DuckDuckGo-backed provider. Anonymous by construction: there is no key to
 * configure, so `available()` is constant and `ready()` is omitted (the seam
 * treats a provider without `ready()` as ready).
 */
export class DuckDuckGoSearchProvider {
  readonly id = DDG_PROVIDER_ID;

  /** Cheap and offline: this provider needs no configuration to run. */
  available(): boolean {
    return true;
  }

  /**
   * Run one search. Tries the HTML endpoint first, then the lite endpoint, so a
   * single endpoint's markup change or challenge page does not blank the result.
   *
   * @param request - one query plus the seam's optional result bound.
   * @param signal - caller cancellation, forwarded to every request.
   * @returns the parsed sources, capped to `maxResults`; empty when the pages
   * carried no parseable hit (never a fabricated entry).
   * @throws {@link WebError} `WEB_ABORTED` on cancellation, `WEB_PROVIDER_ERROR`
   * when no endpoint produced a readable response.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const query = request.query.trim();
    if (query.length === 0) throw new WebError('DuckDuckGo search needs a non-empty query', 'INVALID_ARGS');
    throwIfAborted(signal);

    const failures: string[] = [];
    let readable = 0;
    let found: ParsedSearchSource[] = [];

    try {
      const body = await fetchPage(
        HTML_ENDPOINT,
        { method: 'POST', body: new URLSearchParams({ q: query }).toString() },
        signal,
      );
      readable += 1;
      found = parseDuckDuckGoHtml(body);
    } catch (error) {
      if (error instanceof WebError) throw error;
      failures.push(String(error));
    }

    if (found.length === 0) {
      try {
        const body = await fetchPage(
          `${LITE_ENDPOINT}?${new URLSearchParams({ q: query }).toString()}`,
          { method: 'GET', referer: HTML_ENDPOINT },
          signal,
        );
        readable += 1;
        found = parseDuckDuckGoLite(body);
      } catch (error) {
        if (error instanceof WebError) throw error;
        failures.push(String(error));
      }
    }

    if (readable === 0) {
      throw new WebError(
        `DuckDuckGo search failed for ${JSON.stringify(query)}: ${failures.join('; ')}. ` +
          'The HTML endpoints are anonymous but rate-limited; retry later or check outbound HTTPS access.',
        'WEB_PROVIDER_ERROR',
        { cause: failures.length > 0 ? new Error(failures.join('; ')) : undefined },
      );
    }

    const unique = dedupe(found);
    const limit =
      request.maxResults !== undefined && Number.isInteger(request.maxResults) && request.maxResults > 0
        ? request.maxResults
        : undefined;
    const capped = limit === undefined ? unique : unique.slice(0, limit);
    const sources: WebSearchSource[] = capped.map((source) => ({
      url: source.url,
      ...(source.title === undefined ? {} : { title: source.title }),
      ...(source.snippet === undefined ? {} : { snippet: source.snippet }),
    }));
    return { sources, truncated: capped.length < unique.length };
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-ddg';

/** The web seam this provider registers into. */
export const inject = ['web'];

/**
 * Register the DuckDuckGo provider with `ctx.web`.
 *
 * Registration is effect-scoped: the seam returns the disposer for this fiber
 * and disposes it with the plugin, exactly as the reference provider relies on.
 */
export function apply(ctx: { web: { registerSearchProvider(provider: WebSearchProvider): () => void } }): void {
  const provider = new DuckDuckGoSearchProvider();
  ctx.web.registerSearchProvider({
    id: provider.id,
    available: () => provider.available(),
    search: (request, signal) => provider.search(request, signal),
  });
}