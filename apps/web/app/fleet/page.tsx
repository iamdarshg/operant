import { api } from '@/lib/api';
import { StatusWord } from '@/components/StatusWord';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function FleetPage() {
  const [agentsResult, usageResult, healthResult] = await Promise.all([api.agents(), api.usage(), api.health()]);
  const agents = agentsResult.ok ? agentsResult.data.agents : [];
  const usage = usageResult.ok ? usageResult.data.usage : null;

  return (
    <div className="container">
      <div className="screen-head">
        <div>
          <h1>Fleet</h1>
          <p className="lead">
            The agents the router can choose, the tokens spent so far, and what the API reports about itself. Every
            control on this screen would be a lie: the API exposes these as reads only.
          </p>
        </div>
        <span className="label">read-only</span>
      </div>

      <dl className="facts">
        <div>
          <dt>Jobs run</dt>
          <dd>
            <b>{usage ? usage.jobs.toLocaleString('en-GB') : '—'}</b>
          </dd>
        </div>
        <div>
          <dt>Tokens in</dt>
          <dd>
            <b>{usage ? usage.prompt_tokens.toLocaleString('en-GB') : '—'}</b>
          </dd>
        </div>
        <div>
          <dt>Tokens out</dt>
          <dd>
            <b>{usage ? usage.completion_tokens.toLocaleString('en-GB') : '—'}</b>
          </dd>
        </div>
        <div>
          <dt>Agents enabled</dt>
          <dd>
            <b>
              {agents.length === 0 ? '—' : `${agents.filter((agent) => agent.enabled).length} of ${agents.length}`}
            </b>
          </dd>
        </div>
      </dl>
      {!usageResult.ok ? (
        <p className="pending-block" role="alert">
          Usage did not load. {usageResult.error}
        </p>
      ) : (
        <p className="label">
          Totals from the API&apos;s usage summary: token counts summed over every job, with no per-task breakdown
          exposed.
        </p>
      )}

      <section aria-labelledby="agents-head" style={{ marginTop: 'var(--space-xl)' }}>
        <div className="section-head">
          <h2 id="agents-head">Agents</h2>
          <span className="meta">GET /v1/agents</span>
        </div>
        {!agentsResult.ok ? (
          <p className="pending-block" role="alert">
            The agent list did not load. {agentsResult.error}
          </p>
        ) : agents.length === 0 ? (
          <p className="pending-block">The API returned no agents. Without one nothing can be routed.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Role</th>
                <th scope="col">Permission</th>
                <th scope="col" className="n">
                  Concurrency
                </th>
                <th scope="col">State</th>
                <th scope="col">What it is for</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.id}>
                  <td data-label="Agent">
                    <b>{agent.display_name}</b> <code>{agent.id}</code>
                  </td>
                  <td data-label="Role">{agent.role}</td>
                  <td data-label="Permission">{agent.permission_mode}</td>
                  <td className="n" data-label="Concurrency">
                    {agent.max_concurrency}
                  </td>
                  <td data-label="State">
                    <StatusWord status={agent.enabled ? 'succeeded' : 'cancelled'} label={agent.enabled ? 'enabled' : 'disabled'} />
                  </td>
                  <td data-label="What it is for">{agent.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="label">
          No control to enable, disable or re-scope an agent: the route is a read, and a switch here would change
          nothing.
        </p>
      </section>

      <section aria-labelledby="health-head" style={{ marginTop: 'var(--space-xl)' }}>
        <div className="rule-top">
          <div className="section-head">
            <h2 id="health-head">Health</h2>
            <span className="meta">GET /v1/health, read on this request</span>
          </div>
          {!healthResult.ok ? (
            <p className="pending-block" role="alert">
              Health did not load. {healthResult.error}
            </p>
          ) : (
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
          )}
          <p className="label">
            The API reports health; it has no restart route. Restarting the API or the worker happens outside this
            UI, so no button pretends otherwise.
          </p>
        </div>
      </section>
    </div>
  );
}