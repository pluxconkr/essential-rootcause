/**
 * Job dispatcher behind POST /api/jobs/tick (plan §11: "reads job_run, runs the next chunk of each due job (≤ 500
 * rows), persists cursor, returns"; §23.G: returns within 20 s). Schedules: nightly jobs are due once the 02:00
 * America/New_York boundary has passed since their last success; interval jobs once their interval has elapsed; a
 * job with a stored cursor is mid-run and always due. Jobs run one at a time in JOBS order, each with the deadline,
 * and stop between batches; a job that throws keeps its cursor, records the error on job_run and waits
 * RETRY_AFTER_MS. Overlapping callers (pg_cron plus the GitHub Actions fallback) are kept apart by a short lease on
 * started_at. Nothing is kept in memory between ticks (workerd, plan §3.10): job_run is the only state.
 * Server-only module.
 */
import { localMinutes } from '@/domain/time';

import { logEvent } from '../log';
import type { JobRunRow, JobsStore } from '../repos/jobs';
import { ALERT_DISPATCH_INTERVAL_MS, alertDispatch } from './alertDispatch';
import { autoVerify } from './autoVerify';
import { coarsenGps } from './coarsenGps';
import { purgePhotos } from './purgePhotos';
import { PUSH_RECEIPTS_INTERVAL_MS, pushReceipts } from './pushReceipts';
import { recompute } from './recompute';
import { SCENARIO_EVAL_INTERVAL_MS, scenarioEval } from './scenarioEval';
import { isoAt, type JobContext, type JobFn } from './types';
import { WEATHER_POLL_INTERVAL_MS, weatherPoll } from './weatherPoll';

export const TICK_BUDGET_MS = 20_000; // spec: plan §23.G "jobs/tick returns within 20 s" (pg_net timeout 25 s)
/** What the jobs may use of the budget; the rest covers job_run writes and the response. */
export const TICK_DEADLINE_MS = 18_000;
/** A job is not started with less than this left — it could not finish one write batch. */
export const MIN_JOB_MS = 1_500;
/** A failed attempt waits this long before the next try, so a broken job does not hammer the database every minute. */
export const RETRY_AFTER_MS = 5 * 60_000;
/** A run started this recently and not finished is still running in another caller. */
export const LEASE_MS = 90_000;
export const NIGHTLY_LOCAL_MINUTES = 2 * 60; // spec: plan §11 recompute "nightly 02:00" (America/New_York, domain/time TZ)

export type Schedule = { kind: 'nightly' } | { kind: 'every'; ms: number };

export interface JobDef {
  name: string;
  schedule: Schedule;
  run: JobFn;
}

/** plan §11 table (M1 subset). The frequent, cheap job goes first so a long nightly chunk never starves it. */
export const JOBS: readonly JobDef[] = [
  { name: 'pushReceipts', schedule: { kind: 'every', ms: PUSH_RECEIPTS_INTERVAL_MS }, run: pushReceipts },
  // Predictive alerts (plan §11 weatherPoll · scenarioEval · alertDispatch): the poll, then the evaluation of what it stored, then the queued pushes.
  { name: 'alertDispatch', schedule: { kind: 'every', ms: ALERT_DISPATCH_INTERVAL_MS }, run: alertDispatch },
  { name: 'weatherPoll', schedule: { kind: 'every', ms: WEATHER_POLL_INTERVAL_MS }, run: weatherPoll },
  { name: 'scenarioEval', schedule: { kind: 'every', ms: SCENARIO_EVAL_INTERVAL_MS }, run: scenarioEval },
  { name: 'recompute', schedule: { kind: 'nightly' }, run: recompute },
  { name: 'autoVerify', schedule: { kind: 'nightly' }, run: autoVerify },
  { name: 'coarsenGps', schedule: { kind: 'nightly' }, run: coarsenGps },
  { name: 'purgePhotos', schedule: { kind: 'nightly' }, run: purgePhotos },
];

export type SkipReason = 'not_due' | 'running' | 'retry_wait' | 'deadline';

export interface RanJob {
  name: string;
  ok: boolean;
  done: boolean;
  processed: number;
  error?: string;
}

export interface SkippedJob {
  name: string;
  reason: SkipReason;
}

export interface TickResult {
  ran: RanJob[];
  skipped: SkippedJob[];
  tookMs: number;
}

export interface TickOptions {
  store: JobsStore;
  /** The tick's clock (default Date.now()). */
  now?: number;
  /** Default now + TICK_DEADLINE_MS. */
  deadline?: number;
  requestId?: string;
  /** Default JOBS; tests pass their own. */
  jobs?: readonly JobDef[];
}

/** Postgres timestamps may carry microseconds; keep three fraction digits for Date.parse. */
export function parseTs(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(t) ? t : null;
}

/** The most recent 02:00 America/New_York at or before `now` (epoch ms). */
export function latestNightlyBoundary(now: number): number {
  const sinceMin = (localMinutes(now) - NIGHTLY_LOCAL_MINUTES + 1440) % 1440;
  return now - sinceMin * 60_000 - (now % 60_000);
}

/** null when the job should run now, else why it is skipped. */
export function dueState(def: JobDef, run: JobRunRow | undefined, now: number): SkipReason | null {
  const startedAt = parseTs(run?.started_at ?? null);
  const finishedAt = parseTs(run?.finished_at ?? null);
  if (startedAt !== null && (finishedAt === null || finishedAt < startedAt) && now - startedAt < LEASE_MS) return 'running';
  if (run?.ok === false && finishedAt !== null && now - finishedAt < RETRY_AFTER_MS) return 'retry_wait';
  if (run?.cursor) return null;
  const last = parseTs(run?.last_ok_at ?? null);
  if (last === null) return null;
  if (def.schedule.kind === 'nightly') return last < latestNightlyBoundary(now) ? null : 'not_due';
  return now - last >= def.schedule.ms ? null : 'not_due';
}

const emptyRun = (name: string): JobRunRow => ({ name, started_at: null, finished_at: null, ok: null, cursor: null, error: null, last_ok_at: null });

async function runJob(def: JobDef, prev: JobRunRow | undefined, ctx: Omit<JobContext, 'cursor'>): Promise<RanJob> {
  const base = prev ?? emptyRun(def.name);
  const startedAt = isoAt(Date.now());
  await ctx.store.saveRun({ ...base, started_at: startedAt, finished_at: null });
  const t0 = Date.now();
  try {
    const result = await def.run({ ...ctx, cursor: base.cursor });
    const finishedAt = isoAt(Date.now());
    const cursor = result.done ? null : (result.cursor ?? { resume: true });
    await ctx.store.saveRun({ name: def.name, started_at: startedAt, finished_at: finishedAt, ok: true, cursor, error: null, last_ok_at: result.done ? finishedAt : base.last_ok_at });
    logEvent('info', 'jobs.run', { requestId: ctx.requestId, job: def.name, processed: result.processed, done: result.done, durationMs: Date.now() - t0, note: result.note });
    return { name: def.name, ok: true, done: result.done, processed: result.processed };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const message = err.message.slice(0, 500);
    // The cursor and last_ok_at are kept: the next attempt resumes the same chunk after RETRY_AFTER_MS.
    await ctx.store.saveRun({ ...base, started_at: startedAt, finished_at: isoAt(Date.now()), ok: false, error: message });
    logEvent('error', 'jobs.failed', { requestId: ctx.requestId, job: def.name, durationMs: Date.now() - t0, error: err });
    return { name: def.name, ok: false, done: false, processed: 0, error: message };
  }
}

export async function tick(opts: TickOptions): Promise<TickResult> {
  const started = Date.now();
  const now = opts.now ?? started;
  const deadline = opts.deadline ?? started + TICK_DEADLINE_MS;
  const requestId = opts.requestId ?? 'tick';
  const jobs = opts.jobs ?? JOBS;
  const runs = new Map((await opts.store.listRuns()).map((r) => [r.name, r] as const));
  const ran: RanJob[] = [];
  const skipped: SkippedJob[] = [];
  for (const def of jobs) {
    const run = runs.get(def.name);
    const skip = dueState(def, run, now);
    if (skip) {
      skipped.push({ name: def.name, reason: skip });
      continue;
    }
    if (deadline - Date.now() < MIN_JOB_MS) {
      skipped.push({ name: def.name, reason: 'deadline' });
      continue;
    }
    ran.push(await runJob(def, run, { store: opts.store, now, deadline, requestId }));
  }
  const tookMs = Date.now() - started;
  logEvent('info', 'jobs.tick', { requestId, ran: ran.map((r) => `${r.name}:${r.ok ? (r.done ? 'done' : 'partial') : 'failed'}`), skipped: skipped.map((s) => `${s.name}:${s.reason}`), tookMs });
  return { ran, skipped, tookMs };
}
