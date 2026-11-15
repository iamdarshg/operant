'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import type { Accepted } from '@/lib/shape';

export function ComposeForm() {
  const router = useRouter();
  const fieldId = useId();
  const [text, setText] = useState('');
  const [requestedBy, setRequestedBy] = useState('dashboard');
  const [verify, setVerify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Accepted | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = text.trim();
    if (body.length === 0) {
      setError('Write the request first. It is sent as-is.');
      return;
    }
    setBusy(true);
    setError(null);
    setAccepted(null);
    try {
      const res = await fetch('/api/v1/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: body,
          origin: 'dashboard',
          requestedBy: requestedBy.trim() || 'dashboard',
          requireVerification: verify,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as Partial<Accepted> & {
        error?: string;
        issues?: unknown;
      };
      if (!res.ok || !payload.taskId) {
        setError(
          payload.error
            ? `${payload.error}${payload.issues ? `: ${JSON.stringify(payload.issues).slice(0, 240)}` : ''}`
            : `the control plane answered ${res.status}`,
        );
        return;
      }
      setAccepted(payload as Accepted);
      setText('');
      router.refresh();
    } catch (err) {
      setError(`the request never left this page: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="dispatch" onSubmit={onSubmit} aria-describedby={`${fieldId}-help`}>
      <div className="dispatch__field">
        <label className="label" htmlFor={`${fieldId}-text`}>
          Request
        </label>
        <textarea
          id={`${fieldId}-text`}
          name="text"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Tell the fleet what to do, in one or two sentences."
          disabled={busy}
          required
        />
        <p className="label" id={`${fieldId}-help`}>
          Sent verbatim to POST /v1/requests with origin dashboard.
        </p>
      </div>
      <div className="dispatch__side">
        <label className="label" htmlFor={`${fieldId}-by`}>
          Requested by
        </label>
        <input
          id={`${fieldId}-by`}
          name="requestedBy"
          type="text"
          value={requestedBy}
          onChange={(e) => setRequestedBy(e.target.value)}
          autoComplete="off"
          disabled={busy}
        />
        <label className="check" htmlFor={`${fieldId}-verify`}>
          <input
            id={`${fieldId}-verify`}
            name="requireVerification"
            type="checkbox"
            checked={verify}
            onChange={(e) => setVerify(e.target.checked)}
            disabled={busy}
          />
          Ask for a second job to verify the result
        </label>
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Dispatching…' : 'Dispatch request'}
        </button>
        {error ? (
          <p className="feedback feedback--error" role="alert">
            {error}
          </p>
        ) : null}
        {accepted ? (
          <p className="feedback feedback--ok" role="status">
            Accepted as <b>{accepted.taskId.slice(0, 8)}</b>, routed to {accepted.agentId}.
            <Link href={`/tasks/${accepted.taskId}`}>Open the task</Link>
          </p>
        ) : null}
      </div>
    </form>
  );
}