'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MemoryKind } from '@/lib/shape';

const KINDS: MemoryKind[] = ['episodic', 'semantic', 'procedural', 'failure', 'evaluation'];

const KIND_HELP: Record<MemoryKind, string> = {
  episodic: 'What happened on one run.',
  semantic: 'A fact that stays true.',
  procedural: 'How a job should be done.',
  failure: 'What broke, and why.',
  evaluation: 'A judged outcome with a verdict.',
};

type Written = { id: string; kind: string; title: string; importance: number };

export function MemoryWriter() {
  const router = useRouter();
  const uid = useId();
  const [kind, setKind] = useState<MemoryKind>('semantic');
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [importance, setImportance] = useState('0.5');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [written, setWritten] = useState<Written | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setWritten(null);
    const parsedImportance = Number(importance);
    try {
      const res = await fetch('/api/v1/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          scope,
          title: title.trim(),
          body: body.trim(),
          importance: Number.isFinite(parsedImportance) ? Math.min(1, Math.max(0, parsedImportance)) : 0.5,
          ...(tags.trim()
            ? { tags: tags.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0).slice(0, 20) }
            : {}),
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        memory?: Written;
        error?: string;
        issues?: unknown;
      };
      if (!res.ok || !payload.memory) {
        setError(
          payload.error
            ? `${payload.error}${payload.issues ? `: ${JSON.stringify(payload.issues).slice(0, 240)}` : ''}`
            : `the control plane answered ${res.status}`,
        );
        return;
      }
      setWritten(payload.memory);
      setTitle('');
      setBody('');
      setTags('');
      router.refresh();
    } catch (err) {
      setError(`the write never left this page: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="write-form" onSubmit={onSubmit}>
      <div className="field">
        <label className="label" htmlFor={`${uid}-kind`}>
          Kind
        </label>
        <select
          id={`${uid}-kind`}
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as MemoryKind)}
          disabled={busy}
        >
          {KINDS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <p className="label">{KIND_HELP[kind]}</p>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${uid}-scope`}>
          Scope
        </label>
        <select
          id={`${uid}-scope`}
          name="scope"
          value={scope}
          onChange={(e) => setScope(e.target.value as 'global' | 'project')}
          disabled={busy}
        >
          <option value="global">global</option>
          <option value="project">project</option>
        </select>
        <p className="label">A project memory also needs a project key, which this form does not set.</p>
      </div>
      <div className="field field--wide">
        <label className="label" htmlFor={`${uid}-title`}>
          Title
        </label>
        <input
          id={`${uid}-title`}
          name="title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          required
          disabled={busy}
          placeholder="One line a future job can search for"
        />
      </div>
      <div className="field field--wide">
        <label className="label" htmlFor={`${uid}-body`}>
          Body
        </label>
        <textarea
          id={`${uid}-body`}
          name="body"
          rows={5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={20000}
          required
          disabled={busy}
          placeholder="What should be remembered, and what makes it true."
        />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${uid}-tags`}>
          Tags, comma separated
        </label>
        <input
          id={`${uid}-tags`}
          name="tags"
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          disabled={busy}
          placeholder="postgres, deploy"
        />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${uid}-importance`}>
          Importance, 0 to 1
        </label>
        <input
          id={`${uid}-importance`}
          name="importance"
          type="number"
          min="0"
          max="1"
          step="0.05"
          value={importance}
          onChange={(e) => setImportance(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="write-form__actions">
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Writing…' : 'Write memory'}
        </button>
        {error ? (
          <p className="feedback feedback--error" role="alert">
            {error}
          </p>
        ) : null}
        {written ? (
          <p className="feedback feedback--ok" role="status">
            Stored {written.kind} <b>{written.title}</b> as {written.id.slice(0, 8)}, importance {written.importance}.
          </p>
        ) : null}
      </div>
    </form>
  );
}