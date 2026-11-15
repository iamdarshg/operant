import { api } from '@/lib/api';
import { ApprovalRow } from '@/components/ApprovalRow';
import { AutoRefresh } from '@/components/AutoRefresh';

export const metadata = { title: 'Approvals' };

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function ApprovalsPage() {
  const result = await api.approvals();
  const approvals = result.ok ? result.data.approvals : [];

  return (
    <div className="container">
      {/* A held approval is time-sensitive; the queue must not go stale while it sits open. */}
      <AutoRefresh active={approvals.length > 0} intervalMs={5000} />
      <div className="screen-head">
        <div>
          <h1>Approvals</h1>
          <p className="lead">
            Actions a job stopped to ask about. The queue shows only what the API reports as pending; a decided
            approval leaves this list.
          </p>
        </div>
        <span className="label">{result.ok ? `${approvals.length} pending` : 'queue did not load'}</span>
      </div>

      {!result.ok ? (
        <p className="pending-block" role="alert">
          The approval queue did not load. {result.error}
        </p>
      ) : approvals.length === 0 ? (
        <p className="pending-block">
          Nothing is pending. Approvals are raised by jobs that hit an action the API marks risky, so an empty queue
          means no job is waiting for a decision.
        </p>
      ) : (
        <div className="sheet" style={{ marginTop: 'var(--space-lg)' }}>
          {approvals.map((approval) => (
            <ApprovalRow key={approval.id} approval={approval} />
          ))}
        </div>
      )}

      <section aria-labelledby="how-head" style={{ marginTop: 'var(--space-xl)' }}>
        <div className="rule-top">
          <h2 id="how-head">How a decision travels</h2>
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">What the API does</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td data-label="Step">Raised</td>
                <td data-label="What the API does">
                  A job writes an approval with a summary, a risk and the action it wants to take. It then waits.
                </td>
              </tr>
              <tr>
                <td data-label="Step">Decided</td>
                <td data-label="What the API does">
                  A decision sets the status to approved or rejected, records who decided and the note, and writes an
                  audit entry. It only applies while the row is still pending.
                </td>
              </tr>
              <tr>
                <td data-label="Step">Expired</td>
                <td data-label="What the API does">
                  An approval carries an expiry. Past it, the decision is refused and the queue stops showing the row.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

