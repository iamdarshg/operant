'use client';

import { useId, useState } from 'react';
import type { Approval } from '@/lib/shape';
import { stamp } from '@/lib/format';

/**
 * Approve or reject through POST /v1/approvals/:id/decide. The row reports the
 * decision the API returned, including the 409 an already-decided approval
 * produces, rather than optimistically showing success.
 */
export function ApprovalActions({ approval }: { approval: Approval }) {
  const uid = useId();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);
  const [decided, setDecided] = useState<Approval | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'reject') {
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch(`/api/v1/approvals/${approval.id}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, decidedBy: 'dashboard', ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as { approval?: Approval; error?: string };
      if (!res.ok || !body.approval) {
        setError(
          res.status === 409
            ? 'The API refused: this approval is no longer pending.'
            : (body.error ?? `the control plane answered ${res.status}`),
        );
        return;
      }
      setDecided(body.approval);
    } catch (err) {
      setError(`the decision never left this page: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  if (decided) {
    return (
      <p className="approval__decided" role="status">
        {decided.status} by {decided.decided_by ?? 'dashboard'} at {stamp(decided.decided_at ?? null)}
        {decided.decision_note ? `: ${decided.decision_note}` : ''}
      </p>
    );
  }

  return (
    <div className="approval__note">
      <label className="label" htmlFor={`${uid}-note`}>
        Note, optional
      </label>
      <input
        id={`${uid}-note`}
        name="note"
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Why you decided this"
        disabled={busy !== null}
      />
      <div className="approval__actions">
        <button className="btn btn--primary" type="button" onClick={() => decide('approve')} disabled={busy !== null}>
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button className="btn" type="button" onClick={() => decide('reject')} disabled={busy !== null}>
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
      {error ? (
        <p className="feedback feedback--error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}