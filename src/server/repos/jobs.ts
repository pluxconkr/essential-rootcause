/**
 * Jobs store for /api/jobs/tick (plan §11 jobs table; §3.10 "jobs chunked and resumable (≤ 500 rows per call, cursor
 * in job_run)"): job_run bookkeeping plus the row access each job needs. Kept beside — not inside — repos/types.ts:
 * the routes' Repos bundle is the request-path contract, the tick has its own. Two implementations: MemoryJobsStore
 * for route tests and the dev server (over the memory reports repo, so a test seeds reports the way the routes do
 * and inspects the same rows afterwards) and SupabaseJobsStore (service role; one statement per call, row writes in
 * small parallel batches so a 500-row chunk fits the tick budget). Both throw on a database error: the dispatcher
 * records the message on job_run and retries the same chunk on a later tick. Server-only module.
 */
import { DEFAULT_WEIGHTS } from '@/domain/score';
import type { InjuryFlag, ScoreTerms, ScoreWeights, SeverityBand } from '@/domain/types';

import { type ServiceClient, getServiceClient } from '../db';
import { logEvent } from '../log';
import { ZERO_TERMS } from './derive';
import type { MemoryReportsRepo } from './memory/reports';
import { OPEN_STATUSES } from './memory/reports';
import { PHOTO_BUCKET } from './supabase/reports';
import type { ReportRow } from './types';

// ---------- Shapes ----------

/** Opaque to the dispatcher, meaningful to one job; persisted as job_run.cursor (jsonb). */
export type JobCursor = Record<string, string | number | boolean>;

/** job_run (plan §6). */
export interface JobRunRow {
  name: string;
  started_at: string | null;
  finished_at: string | null;
  ok: boolean | null;
  cursor: JobCursor | null;
  error: string | null;
  last_ok_at: string | null;
}

/** Keyset position over (created_at, id) ascending — the chunk after this row. */
export type KeysetCursor = { created_at: string; id: string };
/** Keyset position over id ascending. */
export type IdCursor = { id: string };

/** What the nightly recompute re-reads (plan §11): the stored score inputs, never the whole row. */
export interface RecomputeRow {
  id: string;
  created_at: string;
  severity_resident: SeverityBand | null;
  severity_ai: SeverityBand | null;
  severity_confirmed: SeverityBand | null;
  ada_flag: boolean;
  injury_flag: InjuryFlag;
  /** report.exposure_terms jsonb — src/domain/exposure.ts ExposureInputs once intake writes it, {} before. */
  exposure_terms: unknown;
  score: number;
  score_terms: ScoreTerms;
  storm_multiplier: number;
}

export interface ScorePatch {
  id: string;
  score: number;
  score_terms: ScoreTerms;
}

export interface CompletedRow {
  id: string;
  /** A verification row exists (confirm or reject); autoVerify leaves these to the residents. */
  has_verdict: boolean;
}

export interface PointRow {
  id: string;
  created_at: string;
  lat: number;
  lng: number;
}

export interface PointPatch {
  id: string;
  lat: number;
  lng: number;
}

export interface PendingPhotoRow {
  id: string;
  storage_key: string;
  thumb_key: string;
}

export interface JobsStore {
  listRuns(): Promise<JobRunRow[]>;
  saveRun(row: JobRunRow): Promise<void>;
  /** tenant.score_weights; DEFAULT_WEIGHTS when the row is missing or malformed. */
  scoreWeights(): Promise<ScoreWeights>;
  /** Open reports (memory/reports.ts OPEN_STATUSES) after the cursor, (created_at, id) ascending. */
  openReportsAfter(cursor: KeysetCursor | null, limit: number): Promise<RecomputeRow[]>;
  saveScores(patches: readonly ScorePatch[], now: string): Promise<void>;
  /** Reports in status completed whose completion is older than `before`, id ascending after the cursor. */
  completedBefore(before: string, cursor: IdCursor | null, limit: number): Promise<CompletedRow[]>;
  /** completed → verified plus a system report_event; false when the status moved in the meantime. */
  markAutoVerified(id: string, now: string, note: string): Promise<boolean>;
  /** Anonymous reports (reporter_id NULL) created before `before`, after the cursor, (created_at, id) ascending. */
  anonymousReportsBefore(before: string, cursor: KeysetCursor | null, limit: number): Promise<PointRow[]>;
  /** geom and geom_public := the point (an anonymous report publishes its stored point, spec §12). */
  savePoints(patches: readonly PointPatch[], now: string): Promise<void>;
  /** Photos never attached to a report, uploaded before `before`, oldest first. */
  pendingPhotosBefore(before: string, limit: number): Promise<PendingPhotoRow[]>;
  /** Storage objects first, then the rows (still unattached); returns the number of rows removed. */
  deletePhotos(rows: readonly PendingPhotoRow[]): Promise<number>;
  /** rate_limit_counter windows that started before `before` (the migration leaves this to purgePhotos). */
  purgeRateLimitWindowsBefore(before: string): Promise<void>;
}

/** Parallel writes per round trip; 500 rows × ~30 ms sequential would not fit the tick (plan §23.G). */
export const WRITE_PARALLELISM = 10;

async function inBatches<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

const band = (v: unknown): SeverityBand | null => (v === 1 || v === 2 || v === 3 || v === 4 ? v : null);
const byCreatedThenId = (a: { created_at: string; id: string }, b: { created_at: string; id: string }) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

// ---------- Memory ----------

export interface MemoryPendingPhoto extends PendingPhotoRow {
  report_id: string | null;
  created_at: string;
}

export interface MemoryVerification {
  report_id: string;
  verdict: 'confirmed' | 'rejected';
}

export class MemoryJobsStore implements JobsStore {
  readonly runs = new Map<string, JobRunRow>();
  readonly photos: MemoryPendingPhoto[] = [];
  /** The fake bucket: storage keys that exist. */
  readonly storage = new Set<string>();
  readonly verifications: MemoryVerification[] = [];
  /** report.exposure_terms by report id (the memory ReportRow has no such column). */
  readonly exposure = new Map<string, unknown>();
  weights: ScoreWeights = DEFAULT_WEIGHTS;
  private eventSeq = 0;

  constructor(private readonly reports: MemoryReportsRepo) {}

  /** Seed a pending photo and its storage objects (tests). */
  addPhoto(photo: Partial<MemoryPendingPhoto> & { id: string; created_at: string }): MemoryPendingPhoto {
    const row: MemoryPendingPhoto = { report_id: null, storage_key: `photos/${photo.id}.jpg`, thumb_key: `photos/${photo.id}.thumb.jpg`, ...photo };
    this.photos.push(row);
    this.storage.add(row.storage_key);
    this.storage.add(row.thumb_key);
    return row;
  }

  /** When the report became completed: the latest event into that status, else its updated_at. */
  completedAt(row: ReportRow): string {
    const ev = [...row.events].reverse().find((e) => e.to_status === 'completed');
    return ev?.created_at ?? row.updated_at;
  }

  async listRuns(): Promise<JobRunRow[]> {
    return Array.from(this.runs.values()).map((r) => ({ ...r }));
  }

  async saveRun(row: JobRunRow): Promise<void> {
    this.runs.set(row.name, { ...row, cursor: row.cursor ? { ...row.cursor } : null });
  }

  async scoreWeights(): Promise<ScoreWeights> {
    return this.weights;
  }

  async openReportsAfter(cursor: KeysetCursor | null, limit: number): Promise<RecomputeRow[]> {
    return this.reports.rows
      .filter((r) => OPEN_STATUSES.includes(r.status))
      .filter((r) => !cursor || byCreatedThenId(r, cursor) > 0)
      .sort(byCreatedThenId)
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        created_at: r.created_at,
        severity_resident: r.severity_resident,
        severity_ai: r.severity_ai,
        severity_confirmed: r.severity_confirmed,
        ada_flag: r.ada_flag,
        injury_flag: r.injury_flag,
        exposure_terms: this.exposure.get(r.id) ?? {},
        score: r.score,
        score_terms: { ...r.score_terms },
        storm_multiplier: r.storm_multiplier,
      }));
  }

  async saveScores(patches: readonly ScorePatch[], now: string): Promise<void> {
    for (const p of patches) {
      const row = this.reports.rows.find((r) => r.id === p.id);
      if (!row) continue;
      row.score = p.score;
      row.score_terms = { ...p.score_terms };
      row.updated_at = now;
    }
  }

  async completedBefore(before: string, cursor: IdCursor | null, limit: number): Promise<CompletedRow[]> {
    return this.reports.rows
      .filter((r) => r.status === 'completed' && this.completedAt(r) < before)
      .filter((r) => !cursor || r.id > cursor.id)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((r) => ({ id: r.id, has_verdict: this.verifications.some((v) => v.report_id === r.id) }));
  }

  async markAutoVerified(id: string, now: string, note: string): Promise<boolean> {
    const row = this.reports.rows.find((r) => r.id === id);
    if (!row || row.status !== 'completed') return false;
    row.status = 'verified';
    row.updated_at = now;
    row.events.push({ id: `ev_auto_${String(++this.eventSeq).padStart(6, '0')}`, kind: 'auto_verified', actor_type: 'system', actor_id: null, from_status: 'completed', to_status: 'verified', note, created_at: now });
    return true;
  }

  async anonymousReportsBefore(before: string, cursor: KeysetCursor | null, limit: number): Promise<PointRow[]> {
    return this.reports.rows
      .filter((r) => r.reporter_id === null && r.created_at < before)
      .filter((r) => !cursor || byCreatedThenId(r, cursor) > 0)
      .sort(byCreatedThenId)
      .slice(0, limit)
      .map((r) => ({ id: r.id, created_at: r.created_at, lat: r.lat, lng: r.lng }));
  }

  async savePoints(patches: readonly PointPatch[], now: string): Promise<void> {
    for (const p of patches) {
      const row = this.reports.rows.find((r) => r.id === p.id);
      if (!row) continue;
      row.lat = p.lat;
      row.lng = p.lng;
      row.public_lat = p.lat;
      row.public_lng = p.lng;
      row.updated_at = now;
    }
  }

  async pendingPhotosBefore(before: string, limit: number): Promise<PendingPhotoRow[]> {
    return this.photos
      .filter((p) => p.report_id === null && p.created_at < before)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit)
      .map((p) => ({ id: p.id, storage_key: p.storage_key, thumb_key: p.thumb_key }));
  }

  async deletePhotos(rows: readonly PendingPhotoRow[]): Promise<number> {
    let removed = 0;
    for (const r of rows) {
      const idx = this.photos.findIndex((p) => p.id === r.id && p.report_id === null);
      if (idx < 0) continue;
      this.storage.delete(r.storage_key);
      this.storage.delete(r.thumb_key);
      this.photos.splice(idx, 1);
      removed++;
    }
    return removed;
  }

  async purgeRateLimitWindowsBefore(): Promise<void> {
    /* the memory limiter keeps its own windows */
  }
}

// ---------- Supabase ----------

const RUN_COLUMNS = 'name, started_at, finished_at, ok, cursor, error, last_ok_at';
const RECOMPUTE_COLUMNS = 'id, created_at, severity_resident, severity_ai, severity_confirmed, ada_flag, injury_flag, exposure_terms, score, score_terms, storm_multiplier';

const ewkt = (lat: number, lng: number) => `SRID=4326;POINT(${lng} ${lat})`;

/** PostgREST `or` expression for "(created_at, id) > cursor"; values are double-quoted so ':' and '+' are literal. */
function keysetAfter(c: KeysetCursor): string {
  return `created_at.gt."${c.created_at}",and(created_at.eq."${c.created_at}",id.gt."${c.id}")`;
}

function isWeights(v: unknown): v is ScoreWeights {
  if (!v || typeof v !== 'object') return false;
  const w = v as Record<string, unknown>;
  return ['severity', 'exposure', 'community', 'liability', 'decay'].every((k) => typeof w[k] === 'number' && Number.isFinite(w[k]));
}

export class SupabaseJobsStore implements JobsStore {
  constructor(private readonly client: ServiceClient) {}

  async listRuns(): Promise<JobRunRow[]> {
    const { data, error } = await this.client.from('job_run').select(RUN_COLUMNS);
    if (error) throw new Error(`job_run read failed: ${error.message}`);
    return ((data ?? []) as JobRunRow[]).map((r) => ({ ...r, cursor: r.cursor && typeof r.cursor === 'object' ? r.cursor : null }));
  }

  async saveRun(row: JobRunRow): Promise<void> {
    const { error } = await this.client.from('job_run').upsert(row, { onConflict: 'name' });
    if (error) throw new Error(`job_run write failed: ${error.message}`);
  }

  /** The one tenant row (plan §6); the trigger in the migration picks it the same way. */
  async scoreWeights(): Promise<ScoreWeights> {
    const { data, error } = await this.client.from('tenant').select('score_weights').order('created_at', { ascending: true }).limit(1).maybeSingle();
    if (error) {
      logEvent('warn', 'jobs.weights_failed', { message: error.message });
      return DEFAULT_WEIGHTS;
    }
    const w = (data as { score_weights?: unknown } | null)?.score_weights;
    return isWeights(w) ? w : DEFAULT_WEIGHTS;
  }

  async openReportsAfter(cursor: KeysetCursor | null, limit: number): Promise<RecomputeRow[]> {
    let q = this.client.from('report').select(RECOMPUTE_COLUMNS).in('status', [...OPEN_STATUSES]).order('created_at', { ascending: true }).order('id', { ascending: true }).limit(limit);
    if (cursor) q = q.or(keysetAfter(cursor));
    const { data, error } = await q;
    if (error) throw new Error(`report read failed: ${error.message}`);
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      created_at: String(r.created_at),
      severity_resident: band(r.severity_resident),
      severity_ai: band(r.severity_ai),
      severity_confirmed: band(r.severity_confirmed),
      ada_flag: r.ada_flag === true,
      injury_flag: (r.injury_flag as InjuryFlag) ?? 'no',
      exposure_terms: r.exposure_terms ?? {},
      score: Number(r.score ?? 0),
      score_terms: (r.score_terms as ScoreTerms | null) ?? { ...ZERO_TERMS },
      storm_multiplier: Number(r.storm_multiplier ?? 1),
    }));
  }

  async saveScores(patches: readonly ScorePatch[], now: string): Promise<void> {
    await inBatches(patches, WRITE_PARALLELISM, async (p) => {
      const { error } = await this.client.from('report').update({ score: p.score, score_terms: p.score_terms, updated_at: now }).eq('id', p.id);
      if (error) throw new Error(`report score update failed: ${error.message}`);
    });
  }

  async completedBefore(before: string, cursor: IdCursor | null, limit: number): Promise<CompletedRow[]> {
    let q = this.client
      .from('report')
      .select('id')
      .eq('status', 'completed')
      // completed_at is written by the status route; a row without it falls back to its last update
      .or(`completed_at.lt."${before}",and(completed_at.is.null,updated_at.lt."${before}")`)
      .order('id', { ascending: true })
      .limit(limit);
    if (cursor) q = q.gt('id', cursor.id);
    const { data, error } = await q;
    if (error) throw new Error(`report read failed: ${error.message}`);
    const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
    if (ids.length === 0) return [];
    const v = await this.client.from('verification').select('report_id').in('report_id', ids);
    if (v.error) throw new Error(`verification read failed: ${v.error.message}`);
    const judged = new Set(((v.data ?? []) as { report_id: string }[]).map((x) => x.report_id));
    return ids.map((id) => ({ id, has_verdict: judged.has(id) }));
  }

  async markAutoVerified(id: string, now: string, note: string): Promise<boolean> {
    const { data, error } = await this.client.from('report').update({ status: 'verified', verified_at: now, updated_at: now }).eq('id', id).eq('status', 'completed').select('id');
    if (error) throw new Error(`report verify update failed: ${error.message}`);
    if (!data || data.length === 0) return false;
    // The status already moved; a lost event is logged rather than thrown so the job does not retry a verified row.
    const ev = await this.client.from('report_event').insert({ report_id: id, actor_type: 'system', actor_id: null, from_status: 'completed', to_status: 'verified', kind: 'auto_verified', note, created_at: now });
    if (ev.error) logEvent('warn', 'jobs.event_insert_failed', { job: 'autoVerify', reportId: id, message: ev.error.message });
    return true;
  }

  async anonymousReportsBefore(before: string, cursor: KeysetCursor | null, limit: number): Promise<PointRow[]> {
    let q = this.client.from('report').select('id, created_at, lat, lng').is('reporter_id', null).lt('created_at', before).order('created_at', { ascending: true }).order('id', { ascending: true }).limit(limit);
    if (cursor) q = q.or(keysetAfter(cursor));
    const { data, error } = await q;
    if (error) throw new Error(`report read failed: ${error.message}`);
    return ((data ?? []) as { id: string; created_at: string; lat: number | string; lng: number | string }[]).map((r) => ({ id: r.id, created_at: r.created_at, lat: Number(r.lat), lng: Number(r.lng) }));
  }

  async savePoints(patches: readonly PointPatch[], now: string): Promise<void> {
    await inBatches(patches, WRITE_PARALLELISM, async (p) => {
      // EWKT text, the same way the reports repo inserts geom; PostGIS casts it to geography(Point, 4326).
      const { error } = await this.client.from('report').update({ geom: ewkt(p.lat, p.lng), geom_public: ewkt(p.lat, p.lng), updated_at: now }).eq('id', p.id);
      if (error) throw new Error(`report geom update failed: ${error.message}`);
    });
  }

  async pendingPhotosBefore(before: string, limit: number): Promise<PendingPhotoRow[]> {
    const { data, error } = await this.client.from('report_photo').select('id, storage_key, thumb_key').is('report_id', null).lt('created_at', before).order('created_at', { ascending: true }).limit(limit);
    if (error) throw new Error(`report_photo read failed: ${error.message}`);
    return (data ?? []) as PendingPhotoRow[];
  }

  async deletePhotos(rows: readonly PendingPhotoRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const keys = Array.from(new Set(rows.flatMap((r) => [r.storage_key, r.thumb_key]).filter((k) => k && k.length > 0)));
    const removed = await this.client.storage.from(PHOTO_BUCKET).remove(keys);
    if (removed.error) throw new Error(`photo storage remove failed: ${removed.error.message}`);
    const { data, error } = await this.client
      .from('report_photo')
      .delete()
      .in(
        'id',
        rows.map((r) => r.id),
      )
      .is('report_id', null)
      .select('id');
    if (error) throw new Error(`report_photo delete failed: ${error.message}`);
    return data?.length ?? 0;
  }

  async purgeRateLimitWindowsBefore(before: string): Promise<void> {
    const { error } = await this.client.from('rate_limit_counter').delete().lt('window_start', before);
    if (error) throw new Error(`rate_limit_counter purge failed: ${error.message}`);
  }
}

// ---------- Resolution ----------

let override: JobsStore | null = null;

/** The Supabase store, or the test override. Throws ConfigError when the env is missing — the route answers 503. */
export function getJobsStore(): JobsStore {
  return override ?? new SupabaseJobsStore(getServiceClient());
}

/** Tests inject a MemoryJobsStore; null restores the Supabase implementation. */
export function setJobsStore(store: JobsStore | null): void {
  override = store;
}
