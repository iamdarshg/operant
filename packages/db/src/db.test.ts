/**
 * Integration tests for the parts of the database layer where a subtle bug is
 * most expensive: lease claiming, the approval decision transaction, the task
 * status roll-up, and the scheduler's compare-and-swap.
 *
 * These need a real Postgres, because every one of them depends on row locking,
 * `SKIP LOCKED`, or transactional semantics that an in-memory fake would happily
 * get wrong.
 *
 * Run against a scratch database (it is dropped and recreated):
 *   OPERANT_TEST_DATABASE_URL=postgres://operant@127.0.0.1:55432/operant \
 *     pnpm --filter @operant/db run test
 *
 * Skipped (not passed) when no URL is supplied — a skip is visible, a silent
 * green is not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  claimNextJob,
  createDb,
  createSchedule,
  createTaskAwaitingApproval,
  createTaskWithJob,
  decideApproval,
  dueSchedules,
  finalizeJob,
  markScheduleRan,
  migrate,
  type Db,
} from './index.js';

const BASE_URL = process.env['OPERANT_TEST_DATABASE_URL'] ?? '';
const SCRATCH_DB = 'operant_test';

let db: Db;
let admin: ReturnType<typeof postgres>;

beforeAll(async () => {
  if (!BASE_URL) return;

  // Point at the maintenance database so we can recreate the scratch one.
  const maintenance = new URL(BASE_URL);
  maintenance.pathname = '/postgres';
  admin = postgres(maintenance.toString(), { max: 1, onnotice: () => {} });

  const scratchName = SCRATCH_DB;
  await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchName}`);
  await admin.unsafe(`CREATE DATABASE ${scratchName}`);

  const scratch = new URL(BASE_URL);
  scratch.pathname = `/${scratchName}`;
  db = createDb(scratch.toString());

  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, '..', 'migrations');
  await readdir(migrationsDir); // fail loudly if the path is wrong
  await migrate(db, migrationsDir);
}, 60_000);

afterAll(async () => {
  if (!BASE_URL) return;
  await db?.end({ timeout: 5 });
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`).catch(() => {});
  await admin?.end({ timeout: 5 });
});

const newTask = (title: string) => ({
  intent: `test task ${title}`,
  title,
  requestedBy: 'test',
  origin: 'api' as const,
});

const newJob = (title: string) => ({
  kind: 'execute' as const,
  agentId: 'generalist',
  title,
  prompt: title,
  workspacePath: `/tmp/operant-test/${title}`,
  permissionMode: 'workspace-write' as const,
});

describe.skipIf(BASE_URL === '')('database invariants', () => {
  it('applies migrations and seeds the built-in agents', () => {
    return db`SELECT count(*)::int AS n FROM agents`.then((rows) => {
      expect(rows[0]?.n).toBeGreaterThanOrEqual(4);
    });
  });

  it('never hands the same job to two workers (SKIP LOCKED)', async () => {
    const { job } = await createTaskWithJob(db, newTask('locking'), newJob('locking'));

    const claims = await Promise.all([
      claimNextJob(db, 'worker-a'),
      claimNextJob(db, 'worker-b'),
      claimNextJob(db, 'worker-c'),
    ]);

    const ids = claims.filter((c): c is NonNullable<typeof c> => c !== null).map((c) => c.id);
    expect(ids.length).toBeGreaterThan(0);
    // The invariant: no job id appears twice across concurrent claims.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(job.id);

    const row = await db`SELECT status FROM tasks WHERE id = ${job.task_id}`;
    expect(row[0]?.status).toBe('running');
  });

  it('does not count a policy-blocked attempt as a task failure', async () => {
    const { task, job } = await createTaskWithJob(db, newTask('blocked-row'), newJob('blocked-row'));
    await claimNextJob(db, 'w1');
    await finalizeJob(db, job.id, {
      status: 'interrupted',
      error: 'blocked at the tool boundary: make world-writable (bash)',
    });
    let row = await db`SELECT status FROM tasks WHERE id = ${task.id}`;
    // A blocked attempt is a pending decision, not a failed task.
    expect(row[0]?.status).not.toBe('failed');

    const { job: second } = await createTaskWithJob(db, newTask('blocked-row-2'), newJob('blocked-row-2'));
    await claimNextJob(db, 'w1');
    await finalizeJob(db, second.id, { status: 'succeeded', result: 'ok' });
    row = await db`SELECT status FROM tasks WHERE id = ${second.task_id}`;
    expect(row[0]?.status).toBe('succeeded');
  });

  it('creates exactly one job when an approval is granted, and refuses a second decision', async () => {
    const { task, approvalId } = await createTaskAwaitingApproval(
      db,
      newTask('approve-me'),
      {
        agentId: 'generalist',
        title: 'approve-me',
        prompt: 'do it',
        workspacePath: '/tmp/operant-test/approve-me',
        permissionMode: 'workspace-write',
      } as never,
      { summary: 'test approval', actionKind: 'external_message', risk: 'medium', reasons: ['test'] },
    );

    // Held: no job exists yet.
    const before = await db`SELECT count(*)::int AS n FROM jobs WHERE task_id = ${task.id}`;
    expect(before[0]?.n).toBe(0);

    const approved = await decideApproval(db, approvalId, 'approve', 'tester');
    expect(approved.ok).toBe(true);
    if (approved.ok) expect(approved.jobId).toBeTruthy();

    const after = await db`SELECT count(*)::int AS n FROM jobs WHERE task_id = ${task.id}`;
    expect(after[0]?.n).toBe(1);

    // Deciding twice must not create a second job.
    const again = await decideApproval(db, approvalId, 'approve', 'tester');
    expect(again.ok).toBe(false);
    const afterAgain = await db`SELECT count(*)::int AS n FROM jobs WHERE task_id = ${task.id}`;
    expect(afterAgain[0]?.n).toBe(1);
  });

  it('creates no job when an approval is rejected, and cancels the task', async () => {
    const { task, approvalId } = await createTaskAwaitingApproval(
      db,
      newTask('reject-me'),
      {
        agentId: 'generalist',
        title: 'reject-me',
        prompt: 'do it',
        workspacePath: '/tmp/operant-test/reject-me',
        permissionMode: 'workspace-write',
      } as never,
      { summary: 'test rejection', actionKind: 'destructive', risk: 'high', reasons: ['test'] },
    );

    const rejected = await decideApproval(db, approvalId, 'reject', 'tester');
    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.jobId).toBeNull();

    const jobs = await db`SELECT count(*)::int AS n FROM jobs WHERE task_id = ${task.id}`;
    expect(jobs[0]?.n).toBe(0);
    const row = await db`SELECT status FROM tasks WHERE id = ${task.id}`;
    expect(row[0]?.status).toBe('cancelled');
  });

  it('fires a schedule exactly once per occurrence (compare-and-swap)', async () => {
    const past = new Date(Date.now() - 60_000);
    const schedule = await createSchedule(db, {
      title: 'cas',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      timezone: 'Asia/Calcutta',
      prompt: 'tick',
      agentSlug: 'generalist',
      nextRunAt: past,
    });

    const due = await dueSchedules(db);
    expect(due.some((s) => s.id === schedule.id)).toBe(true);

    const first = await markScheduleRan(db, schedule.id, new Date(Date.now() + 86_400_000));
    expect(first).toBe(true);

    // The occurrence has advanced, so a second worker's claim must fail.
    const second = await markScheduleRan(db, schedule.id, new Date(Date.now() + 86_400_000));
    expect(second).toBe(false);
  });
});

if (BASE_URL === '') {
  // Deliberately visible: a skipped suite is not a passing one.
  console.warn(
    '[db.test] SKIPPED — set OPERANT_TEST_DATABASE_URL to a Postgres you can recreate a scratch database on.',
  );
}