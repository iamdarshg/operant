'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Cancel is destructive, so it is confirmed inline rather than in a modal. The
 * API decides whether anything can actually be cancelled; the button only
 * reports what came back.
 */
export function CancelTask({ taskId, status }: { taskId: string; status: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  async function cancel() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/tasks/${taskId}/cancel`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { cancelled?: boolean; error?: string };
      if (!res.ok) {
        setMessage({ tone: 'error', text: body.error ?? `the control plane answered ${res.status}` });
        return;
      }
      if (body.cancelled) {
        setMessage({ tone: 'ok', text: `Cancelled. The task is now ${status === 'running' ? 'cancelled' : 'closed'} upstream.` });
        router.refresh();
      } else {
        setMessage({
          tone: 'error',
          text: 'Nothing was cancelled: the API only cancels a task that is still queued, dispatched or running.',
        });
      }
    } catch (err) {
      setMessage({ tone: 'error', text: `the request never left this page: ${String(err)}` });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <div className="btn-row">
        <button className="btn btn--quiet" type="button" onClick={() => setConfirming(true)}>
          Cancel task
        </button>
        {message ? (
          <p className={`feedback feedback--${message.tone === 'ok' ? 'ok' : 'error'}`} role={message.tone === 'ok' ? 'status' : 'alert'}>
            {message.text}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="btn-row">
      <span className="label">Stop this task and its job?</span>
      <button className="btn" type="button" onClick={cancel} disabled={busy}>
        {busy ? 'Cancelling…' : 'Yes, cancel it'}
      </button>
      <button className="btn btn--quiet" type="button" onClick={() => setConfirming(false)} disabled={busy}>
        Keep running
      </button>
    </div>
  );
}