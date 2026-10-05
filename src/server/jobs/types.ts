/**
 * Shared contract between the dispatcher (src/server/jobs/tick.ts) and the jobs (plan §11; §3.10 "jobs chunked and
 * resumable (≤ 500 rows per call, cursor in job_run)"; §23.G "jobs/tick returns within 20 s"). A job reads at most
 * CHUNK_SIZE rows per call, writes in WRITE_BATCH groups, checks outOfTime() between groups and returns where it
 * stopped; the dispatcher persists that cursor and calls again on the next tick. Server-only module.
 */
import type { IdCursor, JobCursor, JobsStore, KeysetCursor } from '../repos/jobs';

export const CHUNK_SIZE = 500; // spec: plan §3.10 / §11 "≤ 500 rows per call"
/** Rows written between two deadline checks (WRITE_PARALLELISM-wide round trips in the Supabase store). */
export const WRITE_BATCH = 50;

export interface JobContext {
  store: JobsStore;
  /** The tick's clock (epoch ms); every "older than N days" cut-off derives from it. */
  now: number;
  /** Epoch ms after which the job must stop and return what it has. */
  deadline: number;
  requestId: string;
  /** Where the previous call stopped; null for a fresh run. */
  cursor: JobCursor | null;
}

export interface JobResult {
  /** True when the run has nothing left; the dispatcher then records last_ok_at and clears the cursor. */
  done: boolean;
  /** Where to resume when not done; the dispatcher substitutes a marker when a job returns null here. */
  cursor: JobCursor | null;
  /** Rows this call changed (or examined, for the recompute) — for the log line, not for correctness. */
  processed: number;
  note?: string;
}

export type JobFn = (ctx: JobContext) => Promise<JobResult>;

export const outOfTime = (ctx: Pick<JobContext, 'deadline'>): boolean => Date.now() >= ctx.deadline;

export const isoAt = (ms: number): string => new Date(ms).toISOString();

export function keysetCursor(c: JobCursor | null): KeysetCursor | null {
  return c && typeof c.created_at === 'string' && typeof c.id === 'string' ? { created_at: c.created_at, id: c.id } : null;
}

export function idCursor(c: JobCursor | null): IdCursor | null {
  return c && typeof c.id === 'string' ? { id: c.id } : null;
}
