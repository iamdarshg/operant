# @operant/web-search-ddg

Anonymous DuckDuckGo search provider for the DeepSeek Harness web seam (`ctx.web`).
No API key, no account, no third-party search service — it POSTs a query to
`https://html.duckduckgo.com/html/`, falls back to `https://lite.duckduckgo.com/lite/`,
and parses the server-rendered results.

```ts
import { name, inject, apply } from '@operant/web-search-ddg'
```

- `name = 'web-search-ddg'` (loader diagnostics)
- `inject = ['web']`
- `apply(ctx)` → `ctx.web.registerSearchProvider({ id: 'duckduckgo', available, search })`
- provider `id = 'duckduckgo'`; pin it with `web.searchProvider: duckduckgo`

Registration is effect-scoped: the seam returns a disposer for the calling fiber, so the
provider unmounts with the plugin. `available()` is a constant (`true`) and makes no
network call; `ready()` is omitted, which the seam treats as ready.

## Contract

- `search()` honours the caller's `AbortSignal`; cancellation surfaces as `WebError`
  with code `WEB_ABORTED`.
- Transport/HTTP failure on both endpoints throws `WebError` code `WEB_PROVIDER_ERROR`.
- Sources map onto the seam's `WebSearchSource` fields (`url`, `title`, `snippet`) and
  omit fields the page did not supply. An empty page returns
  `{ sources: [], truncated: false }` — results are never fabricated.
- `maxResults` is applied at the request layer; `truncated` is `true` when this provider
  dropped hits to honour it.
- Runtime deps: Node builtins and global `fetch` only. The single peer,
  `@deepseek-ai/dsh-web`, is supplied by the dsh installation (profile runtime
  resolution routes it), or by the local `node_modules` junction used for `tsc`.

## Layout

| Path | Role |
| --- | --- |
| `src/index.ts` | plugin exports, provider, request/error handling |
| `src/parse.ts` | DOM-free HTML extraction (no harness import, so plain `node` can test it) |
| `test/fixtures/` | captured live DuckDuckGo pages (`ddg-html-ubuntu.html`, `ddg-lite-ubuntu.html`) |
| `test/check-parser.mjs` | asserts the fixtures still yield url + title + snippet |
| `test/probe*.mjs` | the capture recipes that produced the fixtures |

## Build and test

```pwsh
tsc -p tsconfig.json          # emits dist/
node test/check-parser.mjs    # parser check against the captured fixtures
```

## Limitations

- DuckDuckGo rate-limits the HTML endpoints and serves a bot challenge (HTTP 202) to
  clients it dislikes; when both endpoints fail or produce no parseable hit the provider
  reports zero sources or `WEB_PROVIDER_ERROR` — it does not retry with another service.
- Parsing is positional over the markup (`result__a`/`result__snippet`,
  `result-link`/`result-snippet`). A DuckDuckGo markup change breaks extraction
  (silently → empty sources); `test/check-parser.mjs` is the canary.
- No `publishedAt`: DuckDuckGo's HTML pages carry no per-result timestamp.
- The result page is English (`accept-language: en-US,en;q=0.9`), not locale-aware.