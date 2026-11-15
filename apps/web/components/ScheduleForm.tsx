'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';

/**
 * Create a recurring job.
 *
 * The scheduler existed as an API-only capability, which meant a human could not
 * actually use the feature the platform advertises. This form posts the same
 * payload the API validates, and reports the API's own rejection of an
 * unsupported rule instead of pretending the schedule was accepted.
 */
export function ScheduleForm() {
  const router = useRouter();
  const uid = useId();
  const [title, setTitle] = useState('');
  const [rrule, setRrule] = useState('FREQ=DAILY;BYHOUR=9;BYMINUTE=0');
  const [prompt, setPrompt] = useState('');
  const [agentSlug, setAgentSlug] = useState('generalist');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (title.trim().length === 0 || prompt.trim().length === 0) {
      setError('A schedule needs a title and an instruction for the agent.');
      return;
    }
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const res = await fetch('/api/v1/schedules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          rrule: rrule.trim(),
          prompt: prompt.trim(),
          agentSlug,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        schedule?: { title: string; next_run_at: string };
        error?: string;
        detail?: string;
      };
      if (!res.ok || !body.schedule) {
        setError(
          body.error === 'invalid_rrule'
            ? `That recurrence is not supported: ${body.detail ?? rrule}`
            : (body.detail ?? body.error ?? `the control plane answered ${res.status}`),
        );
        return;
      }
      setCreated(`Next run ${body.schedule.next_run_at}`);
      setTitle('');
      setPrompt('');
      router.refresh();
    } catch (err) {
      setError(`the schedule never left this page: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="write-form">
      <div className="field">
        <label className="label" htmlFor={`${uid}-title`}>
          What is it called
        </label>
        <input
          id={`${uid}-title`}
          name="title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Daily standup summary"
          disabled={busy}
        />
      </div>

      <div className="field field--wide" style={{ display: "grid", gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr)", gap: "var(--space-md)" }}>
        <div className="field">
          <label className="label" htmlFor={`${uid}-rrule`}>
            Recurrence
          </label>
          <input
            id={`${uid}-rrule`}
            name="rrule"
            type="text"
            value={rrule}
            onChange={(e) => setRrule(e.target.value)}
            disabled={busy}
            aria-describedby={`${uid}-hint`}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`${uid}-agent`}>
            Agent
          </label>
          <select
            id={`${uid}-agent`}
            name="agentSlug"
            value={agentSlug}
            onChange={(e) => setAgentSlug(e.target.value)}
            disabled={busy}
          >
            <option value="generalist">generalist</option>
            <option value="engineering">engineering</option>
            <option value="research">research</option>
            <option value="review">review</option>
          </select>
        </div>
      </div>

      <p className="label" id={`${uid}-hint`}>
        Supported: FREQ=DAILY, FREQ=WEEKLY or FREQ=HOURLY, plus INTERVAL, BYHOUR, BYMINUTE, and
        BYDAY when the frequency is weekly. Anything else is refused rather than mis-scheduled.
        Times use your browser zone.
      </p>

      <div className="field">
        <label className="label" htmlFor={`${uid}-prompt`}>
          What the agent should do
        </label>
        <textarea
          id={`${uid}-prompt`}
          name="prompt"
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Summarise yesterday's failures and post the three most useful next actions."
          disabled={busy}
        />
      </div>

      <div className="write-form__actions">
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Scheduling…' : 'Schedule it'}
        </button>
      </div>

      {error ? (
        <p className="feedback feedback--error" role="alert">
          {error}
        </p>
      ) : null}
      {created ? (
        <p className="feedback" role="status">
          Scheduled. {created}
        </p>
      ) : null}
    </form>
  );
}
