/**
 * Parser unit check: runs against fixtures captured from live DuckDuckGo pages
 * (see test/fixtures), so a markup change shows up here before it shows up as an
 * empty `web_search` result.
 *
 * Run: `node test/check-parser.mjs` (or `pnpm --filter @operant/web-search-ddg check:parser`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

import { parseDuckDuckGoHtml, parseDuckDuckGoLite, resolveResultUrl } from '../dist/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

const html = parseDuckDuckGoHtml(fixture('ddg-html-ubuntu.html'));
const lite = parseDuckDuckGoLite(fixture('ddg-lite-ubuntu.html'));

for (const [label, sources] of [['html', html], ['lite', lite]]) {
  assert.ok(sources.length >= 1, `${label}: expected at least one parsed source`);
  for (const source of sources) {
    assert.match(source.url, /^https?:\/\//u, `${label}: url must be absolute http(s), got ${source.url}`);
    assert.doesNotMatch(new URL(source.url).hostname, /duckduckgo\.com$/u, `${label}: redirect wrapper not unwrapped`);
  }
  const first = sources[0];
  assert.ok(typeof first.title === 'string' && first.title.length > 0, `${label}: first source needs a title`);
  assert.ok(typeof first.snippet === 'string' && first.snippet.length > 0, `${label}: first source needs a snippet`);
}

// The redirect wrapper must unwrap, and internal/ad links must be dropped.
const wrapped = resolveResultUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fubuntu.com%2Fabout%2Frelease%2Dcycle&amp;rut=abc');
assert.equal(wrapped, 'https://ubuntu.com/about/release-cycle');
assert.equal(resolveResultUrl('//duckduckgo.com/l/?ad_provider=x'), undefined);
assert.equal(resolveResultUrl('javascript:alert(1)'), undefined);

console.log(`parser html: ${html.length} sources`);
for (const source of html.slice(0, 3)) console.log(`  - ${source.title} | ${source.url}`);
console.log(`parser lite: ${lite.length} sources`);
for (const source of lite.slice(0, 3)) console.log(`  - ${source.title} | ${source.url}`);
console.log('redirect unwrap: OK, internal links dropped: OK');
console.log('PASS');