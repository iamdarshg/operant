import { api } from '@/lib/api';
import { MemoryWriter } from '@/components/MemoryWriter';

export const metadata = { title: 'Memory' };

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function MemoryPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const query = typeof q === 'string' ? q.trim() : '';
  const result = query.length > 0 ? await api.memory(query) : null;
  const matches = result?.ok ? result.data.results : [];

  return (
    <div className="container">
      <div className="screen-head">
        <div>
          <h1>Memory</h1>
          <p className="lead">
            Search what the fleet kept. The index is lexical: it matches words that appear in a title or body, not
            meaning.
          </p>
        </div>
        <span className="label">{query ? `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}` : 'no query yet'}</span>
      </div>

      <form className="search-form" action="/memory" method="get" role="search">
        <div className="field">
          <label className="label" htmlFor="memory-q">
            Query
          </label>
          <input
            id="memory-q"
            name="q"
            type="search"
            defaultValue={query}
            placeholder="a word that appears in what was remembered"
            autoComplete="off"
            required
          />
        </div>
        <button className="btn btn--primary" type="submit">
          Search memory
        </button>
      </form>
      <p className="label">
        The proxy sends only <code>q</code>: the API rejects a string <code>limit</code>, so the default of 8 results
        stands.
      </p>

      <section aria-labelledby="results-head" style={{ marginTop: 'var(--space-xl)' }}>
        <h2 id="results-head">Results</h2>
        {!query ? (
          <p className="pending-block">
            Nothing searched yet. Task outcomes are written here automatically, so a phrase from an earlier request
            is usually the quickest way in.
          </p>
        ) : !result ? null : !result.ok ? (
          <p className="pending-block" role="alert">
            The search failed. {result.error}
          </p>
        ) : matches.length === 0 ? (
          <p className="pending-block">
            No memory matches “{query}”. Every match needs a word that is literally in the record.
          </p>
        ) : (
          <div>
            {matches.map((memory) => (
              <article className="memory-row" key={memory.id}>
                <div>
                  <h3>{memory.title}</h3>
                  <p className="excerpt">{memory.excerpt}</p>
                </div>
                <div className="memory-row__facts">
                  <span>
                    kind <b>{memory.kind}</b>
                  </span>
                  <span>
                    importance <b>{memory.importance.toFixed(2)}</b>
                  </span>
                  <span>matched by {memory.matchedBy}</span>
                  <span>score {memory.score.toFixed(3)}</span>
                  <span>id {memory.id.slice(0, 8)}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="write-head" style={{ marginTop: 'var(--space-xl)' }}>
        <div className="section-head">
          <h2 id="write-head">Write one</h2>
          <span className="meta">POST /v1/memory, stored immediately</span>
        </div>
        <MemoryWriter />
      </section>
    </div>
  );
}
