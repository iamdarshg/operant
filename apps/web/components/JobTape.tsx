'use client';

import { useEffect, useRef, useState } from 'react';
import type { JobEvent } from '@/lib/shape';
import { clock, eventLine, isTerminalJob, stateWord } from '@/lib/format';
import { StatusWord } from './StatusWord';

type Props = {
  jobId: string;
  initialStatus: string;
  initialEvents: JobEvent[];
  initialResult: string | null;
  initialError: string | null;
  agentId: string;
  agentDisplay: string;
  kind: string;
  /** Rows to show; the rest stays in the persisted trail. */
  limit?: number;
  /** The result belongs on the task screen; the control screen shows the tape. */
  showResult?: boolean;
};

const MAX_ROWS = 200;

/**
 * The tape: one job's persisted event trail, continued live over SSE through the
 * server-side proxy. A reconnect resumes from the last seq the client holds, so
 * nothing is missed when the connection drops.
 */
export function JobTape({
  jobId,
  initialStatus,
  initialEvents,
  initialResult,
  initialError,
  agentId,
  agentDisplay,
  kind,
  limit = 200,
  showResult = true,
}: Props) {
  const [events, setEvents] = useState<JobEvent[]>(initialEvents);
  const [status, setStatus] = useState(initialStatus);
  const [result, setResult] = useState(initialResult);
  const [error, setError] = useState(initialError);
  const [streamError, setStreamError] = useState<string | null>(null);
  const lastSeq = useRef<number>(initialEvents.length > 0 ? (initialEvents[initialEvents.length - 1]?.seq ?? -1) : -1);
  const [listening, setListening] = useState(!isTerminalJob(initialStatus));

  useEffect(() => {
    if (isTerminalJob(initialStatus)) return;
    const source = new EventSource(`/api/v1/jobs/${jobId}/stream?after=${lastSeq.current}`);

    const onEvent = (event: MessageEvent<string>) => {
      try {
        const next = JSON.parse(event.data) as JobEvent;
        lastSeq.current = Math.max(lastSeq.current, next.seq);
        setEvents((prev) => (prev.some((row) => row.seq === next.seq) ? prev : [...prev, next].slice(-MAX_ROWS)));
      } catch {
        setStreamError('the stream delivered a line this page could not read');
      }
    };
    const onDone = (event: MessageEvent<string>) => {
      try {
        const done = JSON.parse(event.data) as { status?: string; result?: string | null; error?: string | null };
        if (done.status) setStatus(done.status);
        setResult(done.result ?? null);
        setError(done.error ?? null);
      } finally {
        setListening(false);
        source.close();
      }
    };

    source.addEventListener('job_event', onEvent as EventListener);
    source.addEventListener('job_done', onDone as EventListener);
    source.onopen = () => setStreamError(null);
    source.onerror = () => {
      // EventSource retries on its own; report the reconnect, never fake a close.
      setStreamError('stream reconnecting from the last seq received');
    };

    return () => {
      source.removeEventListener('job_event', onEvent as EventListener);
      source.removeEventListener('job_done', onDone as EventListener);
      source.close();
    };
  }, [jobId, initialStatus]);

  const terminal = isTerminalJob(status);
  const shown = events.length > limit ? events.slice(-limit) : events;

  return (
    <div className="tape">
      <div className="tape__head">
        <p className="tape__ident">
          <StatusWord status={status} />
          <span className="tape__id">job {jobId.slice(0, 8)}</span>
          <span className="tape__id">{kind}</span>
          <span className="tape__id">
            {agentDisplay} ({agentId})
          </span>
        </p>
        <p className="tape__id">
          {events.length} {events.length === 1 ? 'event' : 'events'}
          {listening ? ', stream listening' : ', stream closed'}
        </p>
      </div>

      {events.length === 0 ? (
        <p className="tape__foot">
          No events recorded yet. The worker writes the first one when it claims this job.
        </p>
      ) : (
        <ol className="tape__log" role="log" aria-live="polite" aria-relevant="additions" aria-label="Job events">
          {events.length > limit ? (
            <li className="tape__row tape__row--note">
              <span className="tape__seq">…</span>
              <span className="tape__type">earlier</span>
              <span className="tape__line">earlier events stay in the persisted trail; this shows the last {limit}</span>
              <span className="tape__at" />
            </li>
          ) : null}
          {shown.map((event) => (
            <li className="tape__row" key={`${event.job_id}-${event.seq}`}>
              <span className="tape__seq">{String(event.seq).padStart(2, '0')}</span>
              <span className="tape__type">{event.type}</span>
              <span className="tape__line">{eventLine(event.type, event.payload)}</span>
              <time className="tape__at" dateTime={event.at}>
                {clock(event.at)}
              </time>
            </li>
          ))}
        </ol>
      )}

      <div className="tape__foot">
        <span>
          {streamError
            ? streamError
            : terminal
              ? `the job reached ${stateWord(status)} and the stream closed`
              : 'open over /v1/jobs/:id/stream'}
        </span>
        <span>seq {lastSeq.current}</span>
      </div>

      {showResult && result ? <p className="tape__result">{result}</p> : null}
      {showResult && error ? <p className="tape__result tape__result--error">{error}</p> : null}
    </div>
  );
}