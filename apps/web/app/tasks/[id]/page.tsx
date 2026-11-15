import Link from 'next/link';
import { api } from '@/lib/api';
import { duration, isTerminalJob, isTerminalTask, jobUsage, stamp } from '@/lib/format';
import { CancelTask } from '@/components/CancelTask';
import { JobTape } from '@/components/JobTape';
import { StatusWord } from '@/components/StatusWord';
import { AutoRefresh } from '@/components/AutoRefresh';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ job?: string }>;
}) {
  const { id } = await params;
  const { job: jobParam } = await searchParams;
  const result = await api.task(id);

  if (!result.ok) {
    return (
      <div className="container">
        <p className="label">
          <Link href="/">Back to the board</Link>
        </p>
        <h1>No task to show</h1>
        <p className="pending-block" role="alert">
          {result.status === 404
            ? `The control plane has no task with id ${id}.`
            : `The task did not load. ${result.error}`}
        </p>
      </div>
    );
  }

  const { task, jobs } = result.data;
  const selected =
    jobs.find((job) => job.id === jobParam) ??
    jobs.find((job) => !isTerminalJob(job.status)) ??
    jobs[jobs.length - 1];
  const events = selected ? await api.events(selected.id, -1) : null;
  const terminal = isTerminalTask(task.status);

  return (
    <>
      <AutoRefresh active={!terminal} />
      <div className="container">
        <p className="label">
          <Link href="/">Back to the board</Link>
        </p>
        <div className="screen-head">
          <div>
            <h1>{task.title}</h1>
            <p className="lead">
              {task.intent === task.title
                ? `Task ${task.id.slice(0, 8)}, as dispatched by ${task.requested_by}.`
                : `Task ${task.id.slice(0, 8)}: ${task.intent}`}
            </p>
          </div>
          <StatusWord status={task.status} />
        </div>

        <dl className="facts">
          <div>
            <dt>Origin</dt>
            <dd>{task.origin}</dd>
          </div>
          <div>
            <dt>Requested by</dt>
            <dd>{task.requested_by}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{stamp(task.created_at)}</dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>{stamp(task.started_at)}</dd>
          </div>
          <div>
            <dt>Finished</dt>
            <dd>{stamp(task.finished_at)}</dd>
          </div>
          <div>
            <dt>Took</dt>
            <dd>
              <b>{duration(task.started_at, task.finished_at)}</b>
            </dd>
          </div>
          <div>
            <dt>Verification</dt>
            <dd>{task.require_verification ? 'asked for at dispatch' : 'not asked for'}</dd>
          </div>
          <div>
            <dt>Project</dt>
            <dd>{task.project_path ?? 'none named'}</dd>
          </div>
        </dl>

        {task.failure_reason ? (
          <p className="result-block result-block--error">Failure: {task.failure_reason}</p>
        ) : null}

        <div className="btn-row" style={{ marginTop: 'var(--space-md)' }}>
          {terminal ? (
            <p className="label">
              This task is {task.status}, so the API will not cancel it. The button is absent rather than dead.
            </p>
          ) : (
            <CancelTask taskId={task.id} status={task.status} />
          )}
        </div>
      </div>

      <div className="container" style={{ marginTop: 'var(--space-xl)' }}>
        <div className="section-head">
          <h2>Jobs</h2>
          <span className="meta">
            {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'} on this task
          </span>
        </div>
        {jobs.length === 0 ? (
          <p className="pending-block">This task has no job. The worker creates one when it accepts the request.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Agent</th>
                <th scope="col">Kind</th>
                <th scope="col">Attempt</th>
                <th scope="col">State</th>
                <th scope="col" className="n">
                  Events
                </th>
                <th scope="col" className="n">
                  Tool calls
                </th>
                <th scope="col" className="n">
                  Tokens in
                </th>
                <th scope="col" className="n">
                  Tokens out
                </th>
                <th scope="col" className="n">
                  Took
                </th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td data-label="Job">
                    <Link href={`/tasks/${task.id}?job=${job.id}`}>{job.id.slice(0, 8)}</Link>
                    {selected?.id === job.id ? <span className="label"> on the tape</span> : null}
                  </td>
                  <td data-label="Agent">{job.agent_id}</td>
                  <td data-label="Kind">{job.kind}</td>
                  <td data-label="Attempt">
                    {job.attempt} of {job.max_attempts}
                  </td>
                  <td data-label="State">
                    <StatusWord status={job.status} />
                  </td>
                  <td className="n" data-label="Events">
                    {jobUsage(job).events}
                  </td>
                  <td className="n" data-label="Tool calls">
                    {jobUsage(job).toolCalls}
                  </td>
                  <td className="n" data-label="Tokens in">
                    {jobUsage(job).promptTokens}
                  </td>
                  <td className="n" data-label="Tokens out">
                    {jobUsage(job).completionTokens}
                  </td>
                  <td className="n" data-label="Took">
                    {duration(job.started_at, job.finished_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {selected ? (
          <div className="split" style={{ marginTop: 'var(--space-xl)' }}>
            <div className="pane">
              <div className="section-head">
                <h2>Tape</h2>
                <span className="meta">{isTerminalJob(selected.status) ? 'closed job' : 'live job'}</span>
              </div>
              {events?.ok ? (
                <JobTape
                  jobId={selected.id}
                  initialStatus={selected.status}
                  initialEvents={events.data.events}
                  initialResult={selected.result}
                  initialError={selected.error}
                  agentId={selected.agent_id}
                  agentDisplay={selected.agent_id}
                  kind={selected.kind}
                />
              ) : (
                <p className="pending-block" role="alert">
                  The event trail did not load. {events?.error}
                </p>
              )}
            </div>
            <div className="pane pane--sheet">
              <h2>This job</h2>
              <dl className="facts" style={{ borderTop: 'none', marginTop: 0 }}>
                <div>
                  <dt>Workspace</dt>
                  <dd>
                    <code>{selected.workspace_path}</code>
                  </dd>
                </div>
                <div>
                  <dt>Permission</dt>
                  <dd>{selected.permission_mode}</dd>
                </div>
                <div>
                  <dt>Profile</dt>
                  <dd>{selected.dsh_profile}</dd>
                </div>
                <div>
                  <dt>Session</dt>
                  <dd>{selected.dsh_session_id ?? 'not reported yet'}</dd>
                </div>
                <div>
                  <dt>Verified by</dt>
                  <dd>
                    {(selected.verified_by_job_ids ?? []).length === 0
                      ? 'no verification job'
                      : (selected.verified_by_job_ids ?? []).map((jobId) => jobId.slice(0, 8)).join(', ')}
                  </dd>
                </div>
              </dl>
              {selected.result ? <p className="result-block">{selected.result}</p> : null}
              {selected.error ? <p className="result-block result-block--error">{selected.error}</p> : null}
              <details>
                <summary>The prompt this job was given</summary>
                <pre>{selected.prompt}</pre>
              </details>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}