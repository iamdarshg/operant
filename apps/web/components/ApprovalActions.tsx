'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Approval } from '@/lib/shape';
import { stamp } from '@/lib/format';

/** What POST /v1/approvals/:id/decide actually returns. */
interface DecideResponse {
  decided?: boolean;
  decision?: 'approve' | 'reject';
  taskId?: string;
  jobId?: string | null;
  status?: string;
  error?: string;
  detail?: string;
}

interface Decided {
  decision: 'approve' | 'reject';
  status: string;
  taskId: string | null;
  jobId: string | null;
}

/**
 * Approve or reject through POST /v1/approvals/:id/decide.
 *
 * The API answers `{decided, decision, taskId, jobId, status}` — it moved from
 * returning the raw approval row, and the client kept requiring the old
 * `body.approval`, so a successful decision rendered as "the control plane
 * answered 200" and the row stayed pending. Treating `decided:true` as the
 * success signal is the contract; on success we refresh the server-rendered
 * queue so the row and the pending counter cannot go stale.
 */
export function ApprovalActions({ approval }: { approval: Approval }) {
  const uid = useId();
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);
  const [decided, setDecided] = useState<Decided | null>(null);
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
      const body = (await res.json().catch(() => ({}))) as DecideResponse;

      if (!res.ok || body.decided !== true) {
        setError(
          res.status === 409
            ? `The API refused: ${body.detail ?? 'this approval is no longer pending.'}`
            : (body.error ?? `the control plane answered ${res.status}`),
        );
        return;
      }

      setDecided({
        decision: body.decision ?? decision,
        status: body.status ?? 'queued',
        taskId: body.taskId ?? null,
        jobId: body.jobId ?? null,
      });
      // Server-rendered queue: refetch so the decided row leaves "pending" and
      // the counter changes, instead of the page lying until a manual reload.
      router.refresh();
    } catch (err) {
      setError(`the decision never left this page: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  if (decided) {
    const rejected = decided.decision === 'reject';
    return (
      <div className="approval__decided" role="status">
        <p>
          {rejected ? 'Rejected' : 'Approved'} by dashboard at {stamp(new Date().toISOString())}.{' '}
          {rejected ? (
            <>The task was cancelled and no job was created.</>
          ) : decided.jobId ? (
            <>
              A job exists now: <a href={`/tasks/${decided.taskId ?? ''}`}>{decided.jobId.slice(0, 8)}</a> — the task was{' '}
              {decided.status}.
            </>
          ) : (
            <>The task was {decided.status}.</>
          )}
        </p>
      </div>
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