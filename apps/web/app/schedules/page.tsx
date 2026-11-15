import { api } from '@/lib/api';
import { stamp } from '@/lib/format';
import { ScheduleForm } from '@/components/ScheduleForm';
import { ScheduleDelete } from '@/components/ScheduleDelete';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Recurring work.
 *
 * The scheduler was API-only, which made the platform's "scheduled and recurring
 * jobs" claim unusable by a human. The list shows what will run, when, and whether
 * it has ever fired — the three things you need to trust a cron replacement.
 */
export default async function SchedulesPage() {
  const result = await api.schedules();
  const schedules = result.ok ? result.data.schedules : [];

  return (
    <div className="container">
      <div className="screen-head">
        <div>
          <h1>Schedules</h1>
          <p className="lead">
            Recurring work. The worker checks once a minute and enqueues a normal task, so a scheduled
            run is auditable exactly like a request you typed.
          </p>
        </div>
        <span className="label">
          {result.ok ? `${schedules.length} ${schedules.length === 1 ? 'schedule' : 'schedules'}` : 'list did not load'}
        </span>
      </div>

      {!result.ok ? (
        <p className="pending-block" role="alert">
          The control plane did not return schedules, so nothing here can be trusted. {result.error}
        </p>
      ) : null}

      {result.ok && schedules.length === 0 ? (
        <p className="pending-block">
          No recurring work yet. Add one below and the next occurrence appears immediately.
        </p>
      ) : null}

      {schedules.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Recurrence</th>
              <th scope="col">Next run</th>
              <th scope="col">Last fired</th>
              <th scope="col">State</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {schedules.map((schedule) => (
              <tr key={schedule.id}>
                <td data-label="Title">{schedule.title}</td>
                <td className="meta" data-label="Recurrence">{schedule.rrule}</td>
                <td className="meta" data-label="Next run">{stamp(schedule.next_run_at)}</td>
                <td className="meta" data-label="Last fired">{schedule.last_run_at ? stamp(schedule.last_run_at) : 'never'}</td>
                <td data-label="State">{schedule.enabled ? 'enabled' : 'disabled'}</td>
                <td>
                  <ScheduleDelete id={schedule.id} title={schedule.title} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {/* No nested .container: a second one doubles the horizontal padding and
          pushes the page past the viewport at 390px (measured: the footer, which
          this page does not own, was clipped too). */}
      <div style={{ marginTop: 'var(--space-xl)' }}>
        <div className="section-head">
          <h2>Add a schedule</h2>
        </div>
        <ScheduleForm />
      </div>
    </div>
  );
}
