/**
 * recompute (plan §11, nightly 02:00): re-derives each open report's score from its stored inputs with
 * src/domain/score so the decay term keeps moving and a changed tenant weight reaches every row. Terms: severity
 * from the stored bands (confirmed ?? ai ?? resident), exposure from report.exposure_terms (the OSM proxy written
 * at intake; the stored term for rows that predate it), liability from ada_flag / injury_flag, decay from
 * created_at. The community term is kept as stored: its inputs (vote weights, active users) are not on the row and
 * the votes route owns it. block_group_stats, vote anomaly flags and scenario multipliers are M2+ (plan §15); the
 * block-group rollup logs "needs block_group load (M2)" once per run. Chunked with a (created_at, id) keyset cursor.
 */
import { decayTerm, effectiveSeverity, exposureTerm, liabilityTerm, scoreFromTerms, severityTerm, TERM_KEYS, type ExposureFlags } from '@/domain/score';
import { daysBetween } from '@/domain/time';
import type { ScoreTerms, ScoreWeights } from '@/domain/types';

import { logEvent } from '../log';
import { ZERO_TERMS } from '../repos/derive';
import type { RecomputeRow, ScorePatch } from '../repos/jobs';
import { CHUNK_SIZE, WRITE_BATCH, isoAt, keysetCursor, outOfTime, type JobFn } from './types';

export const BLOCK_GROUP_STATS_TODO = 'needs block_group load (M2)'; // plan §15: Census load and rollup_block_groups() land in M2

/** report.exposure_terms as written by src/server/exposure.ts lookupExposure; null when the row predates it. */
export function storedExposure(v: unknown): { pedsPerDay: number; flags: ExposureFlags } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { pedsPerDay?: unknown; flags?: unknown };
  if (typeof o.pedsPerDay !== 'number' || !Number.isFinite(o.pedsPerDay)) return null;
  const f = (o.flags && typeof o.flags === 'object' ? o.flags : {}) as Record<string, unknown>;
  return { pedsPerDay: o.pedsPerDay, flags: { schoolRoute: f.schoolRoute === true, seniorFacility: f.seniorFacility === true, transitStop: f.transitStop === true, adaRoute: f.adaRoute === true } };
}

/** The new score and terms for one row, or null when nothing would change. */
export function recomputeOne(row: RecomputeRow, nowMs: number, weights: ScoreWeights): ScorePatch | null {
  const stored: ScoreTerms = { ...ZERO_TERMS, ...row.score_terms };
  const exposure = storedExposure(row.exposure_terms);
  const terms: ScoreTerms = {
    severity: severityTerm(effectiveSeverity({ confirmed: row.severity_confirmed, ai: row.severity_ai, resident: row.severity_resident })),
    exposure: exposure ? exposureTerm(exposure.pedsPerDay, exposure.flags) : stored.exposure,
    community: stored.community,
    liability: liabilityTerm(row.ada_flag, row.injury_flag, null),
    decay: decayTerm(daysBetween(row.created_at, nowMs)),
  };
  const score = scoreFromTerms(terms, weights, row.storm_multiplier);
  const unchanged = score === row.score && TERM_KEYS.every((k) => Math.abs(terms[k] - stored[k]) < 1e-9);
  return unchanged ? null : { id: row.id, score, score_terms: terms };
}

export const recompute: JobFn = async (ctx) => {
  const cursor = keysetCursor(ctx.cursor);
  if (!cursor) logEvent('info', 'jobs.recompute.block_group_stats', { requestId: ctx.requestId, note: BLOCK_GROUP_STATS_TODO });
  const weights = await ctx.store.scoreWeights();
  const rows = await ctx.store.openReportsAfter(cursor, CHUNK_SIZE);
  const nowIso = isoAt(ctx.now);
  let last = cursor;
  let processed = 0;
  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    if (outOfTime(ctx)) return { done: false, cursor: last, processed };
    const batch = rows.slice(i, i + WRITE_BATCH);
    const patches = batch.map((r) => recomputeOne(r, ctx.now, weights)).filter((p): p is ScorePatch => p !== null);
    if (patches.length > 0) await ctx.store.saveScores(patches, nowIso);
    processed += batch.length;
    const tail = batch[batch.length - 1];
    last = { created_at: tail.created_at, id: tail.id };
  }
  const done = rows.length < CHUNK_SIZE;
  return { done, cursor: done ? null : last, processed };
};
