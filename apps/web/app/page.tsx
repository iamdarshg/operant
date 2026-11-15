import Link from 'next/link';
import { api } from '@/lib/api';
import { age, duration, isTerminalJob, isTerminalTask } from '@/lib/format';
import { ComposeForm } from '@/components/ComposeForm';
import { JobTape } from '@/components/JobTape';
import { ApprovalRow } from '@/components/ApprovalRow';
import { AutoRefresh } from '@/components/AutoRefresh';
import { StatusWord } from '@/components/StatusWord';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function ControlPage() {
  const [tasksResult, healthResult, usageResult, approvalsResult, agentsResult] = await Promise.all([
    api.tasks(50),
    api.health(),
    api.usage(),
    api.approvals(),
    api.agents(),
  ]);

  const tasks = tasksResult.ok ? tasksResult.data.tasks : [];
  const approvals = approvalsResult.ok ? approvalsResult.data.approvals : [];
  const usage = usageResult.ok ? usageResult.data.usage : null;
  const agents = agentsResult.ok ? agentsResult.data.agents : [];

  // The tape follows the newest task the fleet is still working, and falls back
  // to the newest task on record so the screen never shows an empty player.
  //
  // But a task HELD FOR APPROVAL is non-terminal and has no job at all, so
  // picking purely by "newest non-terminal" pointed the tape at a jobless task
  // and printed "No job exists yet" while other jobs were streaming (QA finding).
  // If the first candidate has no jobs, walk the newest few until one does.
  const openTask = tasks.find((task) => !isTerminalTask(task.status)) ?? tasks[0];
  let detail = openTask ? await api.task(openTask.id) : null;
  // Track which task the tape actually ended up on, so the caption link below
  // cannot point at a different task than the events it is showing.
  let tapeTask = openTask;
  if (detail?.ok && detail.data.jobs.length === 0) {
    for (const candidate of tasks.slice(0, 6)) {
      if (candidate.id === openTask?.id) continue;
      const probe = await api.task(candidate.id);
      if (probe.ok && probe.data.jobs.length > 0) {
        detail = probe;
        tapeTask = candidate;
        break;
      }
    }
  }
  const jobs = detail?.ok ? detail.data.jobs : [];
  const focusJob = jobs.find((job) => !isTerminalJob(job.status)) ?? jobs[jobs.length - 1];
  const events = focusJob ? await api.events(focusJob.id, -1) : null;
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.display_name]));

  const inFlight = tasks.filter((task) => !isTerminalTask(task.status)).length;

  return (
    <>
      <AutoRefresh active={inFlight > 0} />

      <div className="container">
        <div className="screen-head">
          <div>
            <h1>Control</h1>
            <p className="lead">What the fleet is running, and the decisions the API is holding for you.</p>
          </div>
          <dl className="tally">
            <div>
              <dt>jobs run</dt>
              <dd>{usage ? usage.jobs.toLocaleString('en-GB') : '—'}</dd>
            </div>
            <div>
              <dt>tokens in</dt>
              <dd>{usage ? usage.prompt_tokens.toLocaleString('en-GB') : '—'}</dd>
            </div>
            <div>
              <dt>tokens out</dt>
              <dd>{usage ? usage.completion_tokens.toLocaleString('en-GB') : '—'}</dd>
            </div>
            <div>
              <dt>waiting on you</dt>
              <dd>{approvalsResult.ok ? approvals.length : '—'}</dd>
            </div>
          </dl>
        </div>

        <ComposeForm />
      </div>

      <section className="band--ink" id="board" aria-labelledby="board-head">
        <div className="container">
          <div className="section-head">
            <h2 id="board-head">Board</h2>
            <span className="meta">
              {tasksResult.ok ? `${tasks.length} read, newest first` : 'the task list did not load'}
              {inFlight > 0 ? `, ${inFlight} in flight` : ', nothing in flight'}
            </span>
          </div>

          {!tasksResult.ok ? (
            <p className="pending-block" role="alert">
              The control plane did not return a task list. {tasksResult.error}
            </p>
          ) : tasks.length === 0 ? (
            <p className="pending-block">
              No request has been dispatched yet. The box above is the only thing that creates one, and it posts as
              soon as you press Dispatch.
            </p>
          ) : (
            <table className="board">
              <thead>
                <tr>
                  <th scope="col">Request</th>
                  <th scope="col">From</th>
                  <th scope="col">State</th>
                  <th scope="col" className="n">
                    Took
                  </th>
                  <th scope="col" className="n">
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <span className="cell-title">
                        <Link className="cell-link" href={`/tasks/${task.id}`}>
                          {task.title}
                        </Link>
                        <span className="cell-meta">
                          <span>id {task.id.slice(0, 8)}</span>
                          {task.require_verification ? <span>verification asked</span> : null}
                        </span>
                      </span>
                    </td>
                    <td data-label="From">
                      <span className="cell-meta">
                        <span>{task.origin}</span>
                        <span>by {task.requested_by}</span>
                      </span>
                    </td>
                    <td className="col-state" data-label="State">
                      <StatusWord status={task.status} />
                    </td>
                    <td className="n" data-label="Took">
                      <span className="figure">{duration(task.started_at, task.finished_at)}</span>
                    </td>
                    <td className="n" data-label="Updated">
                      <time dateTime={task.updated_at}>{age(task.updated_at)}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <div className="container app-main__split">
        <div className="split">
          <div className="pane">
            <div className="section-head">
              <h2>Tape</h2>
              <span className="meta">
                {focusJob ? `${focusJob.id.slice(0, 8)}, newest ${isTerminalJob(focusJob.status) ? 'closed' : 'active'} job` : 'no job yet'}
              </span>
            </div>
            {!focusJob ? (
              <p className="pending-block">
                No job exists yet, so there is no event trail. Dispatch a request and the tape fills as the worker
                writes events.
              </p>
            ) : !events?.ok ? (
              <p className="pending-block" role="alert">
                The event trail did not load. {events?.error}
              </p>
            ) : (
              <>
                <JobTape
                  jobId={focusJob.id}
                  initialStatus={focusJob.status}
                  initialEvents={events.data.events}
                  initialResult={focusJob.result}
                  initialError={focusJob.error}
                  agentId={focusJob.agent_id}
                  agentDisplay={agentNames.get(focusJob.agent_id) ?? focusJob.agent_id}
                  kind={focusJob.kind}
                  limit={16}
                  showResult={false}
                />
                {tapeTask ? (
                  <p className="label">
                    Part of <Link href={`/tasks/${tapeTask.id}`}>{tapeTask.title}</Link>
                  </p>
                ) : null}
              </>
            )}
          </div>

          <div className="pane">
            <div className="section-head">
              <h2>Approvals</h2>
              <span className="meta">{approvalsResult.ok ? `${approvals.length} pending` : 'did not load'}</span>
            </div>
            {!approvalsResult.ok ? (
              <p className="pending-block" role="alert">
                The approval queue did not load. {approvalsResult.error}
              </p>
            ) : approvals.length === 0 ? (
              <p className="pending-block">
                Nothing is waiting on you. A job creates a pending approval when it stops to ask before an action the
                API marks risky; the queue is empty until then.
              </p>
            ) : (
              <div className="sheet">
                {approvals.map((approval) => (
                  <ApprovalRow key={approval.id} approval={approval} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <section className="band" aria-labelledby="service-head">
        <div className="container rule-top">
          <div className="section-head">
            <h2 id="service-head">Service</h2>
            <span className="meta">GET /v1/health, unauthenticated upstream</span>
          </div>
          {healthResult.ok ? (
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Check</th>
                  <th scope="col">State</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {healthResult.data.checks.map((check) => (
                  <tr key={check.name}>
                    <td data-label="Check">{check.name}</td>
                    <td data-label="State">
                      <StatusWord status={check.state === 'healthy' ? 'succeeded' : 'failed'} label={check.state} />
                    </td>
                    <td data-label="Detail">{check.detail ?? 'no detail reported'}</td>
                  </tr>
                ))}
                <tr>
                  <td data-label="Check">dsh profile</td>
                  <td data-label="State">reported by the API</td>
                  <td data-label="Detail">{healthResult.data.dshProfile}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="pending-block" role="alert">
              Health did not load. {healthResult.error}
            </p>
          )}
        </div>
      </section>
    </>
  );
}
