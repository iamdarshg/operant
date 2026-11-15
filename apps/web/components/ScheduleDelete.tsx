'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Delete a schedule through the proxy. Deleting is the only way to stop a
 * recurring job short of disabling it in the database, so it belongs in the UI.
 */
export function ScheduleDelete({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/schedules/${id}`, { method: 'DELETE' });
      const body = (await res.json().catch(() => ({}))) as { deleted?: boolean; error?: string };
      if (!res.ok || body.deleted !== true) {
        setError(body.error ?? `the control plane answered ${res.status}`);
        return;
      }
      router.refresh();
      // The row stays visible until the refresh lands; the button reports the
      // outcome rather than silently doing nothing if the request failed.
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        className="btn"
        type="button"
        onClick={remove}
        disabled={busy}
        aria-label={`Delete schedule ${title}`}
      >
        {busy ? 'Deleting…' : 'Delete'}
      </button>
      {error ? (
        <p className="feedback feedback--error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}