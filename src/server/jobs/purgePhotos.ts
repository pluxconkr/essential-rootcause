/**
 * purgePhotos (plan §7, §11, nightly): photos uploaded through POST /api/v1/photos but never attached to a report
 * are deleted after PURGE_PHOTOS_AFTER_HOURS — the storage objects first, then the rows (still unattached at delete
 * time). The same run drops rate_limit_counter windows older than two days, which the migration leaves to this job
 * (plan §6: hourly and daily windows). Consume-style: each call takes the oldest chunk; a run is done when a chunk
 * comes back short.
 */
import { CHUNK_SIZE, WRITE_BATCH, isoAt, outOfTime, type JobFn } from './types';

export const PURGE_PHOTOS_AFTER_HOURS = 24; // spec: plan §7 "unattached photos purged after 24 h"
export const RATE_LIMIT_WINDOW_RETENTION_HOURS = 48; // plan §23.J: hourly and daily windows — nothing older than two days is read

const HOUR_MS = 3_600_000;

export const purgePhotos: JobFn = async (ctx) => {
  const before = isoAt(ctx.now - PURGE_PHOTOS_AFTER_HOURS * HOUR_MS);
  const rows = await ctx.store.pendingPhotosBefore(before, CHUNK_SIZE);
  let processed = 0;
  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    if (outOfTime(ctx)) return { done: false, cursor: { resume: true }, processed };
    processed += await ctx.store.deletePhotos(rows.slice(i, i + WRITE_BATCH));
  }
  // Once per run (first call): the rate-limit windows.
  if (!ctx.cursor) await ctx.store.purgeRateLimitWindowsBefore(isoAt(ctx.now - RATE_LIMIT_WINDOW_RETENTION_HOURS * HOUR_MS));
  const done = rows.length < CHUNK_SIZE;
  return { done, cursor: done ? null : { resume: true }, processed };
};
