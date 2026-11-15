import type { Approval } from '@/lib/shape';
import { age, stamp } from '@/lib/format';
import { ApprovalActions } from './ApprovalActions';

/**
 * One pending decision. Approvals are rows in the work list, not a modal: the
 * summary, the risk the API reports, when it expires, and the two real buttons.
 */
export function ApprovalRow({ approval }: { approval: Approval }) {
  return (
    <article className="approval">
      <p className="approval__summary">{approval.summary}</p>
      <p className="approval__meta">
        <span className={`approval__risk risk--${approval.risk}`}>{approval.risk} risk</span>
        <span>asked by {approval.requested_by}</span>
        <span>raised {age(approval.created_at)}</span>
        <span>expires {stamp(approval.expires_at)}</span>
      </p>
      <ApprovalActions approval={approval} />
    </article>
  );
}