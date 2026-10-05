/**
 * coarsenGps (plan §11, nightly; spec §12): anonymous reports older than COARSEN_AFTER_DAYS lose their precise
 * point — geom (and geom_public, which equals it for anonymous reports) is replaced by the 50 m grid node from
 * src/domain/geo snapToGrid, address_text stays. The snap is idempotent, so the job compares each stored point with
 * its snapped position and writes only the ones that still move; a nightly pass over the eligible rows is then
 * read-mostly and needs no "already coarsened" flag. Chunked with a (created_at, id) keyset cursor.
 */
import { snapToGrid, type LatLng } from '@/domain/geo';
import { DAY_MS } from '@/domain/time';

import type { PointPatch } from '../repos/jobs';
import { CHUNK_SIZE, WRITE_BATCH, isoAt, keysetCursor, outOfTime, type JobFn } from './types';

export const COARSEN_AFTER_DAYS = 30; // spec: §12 / plan §11 "anonymous reports > 30 d"
export const COARSEN_CELL_M = 50; // spec: plan §11 "geom := 50 m snap"

export function coarsenedPoint(p: LatLng): LatLng {
  return snapToGrid(p, COARSEN_CELL_M);
}

/** Same stored double, allowing for a float round trip through PostGIS. */
export function samePoint(a: LatLng, b: LatLng): boolean {
  return Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;
}

export const coarsenGps: JobFn = async (ctx) => {
  const before = isoAt(ctx.now - COARSEN_AFTER_DAYS * DAY_MS);
  const cursor = keysetCursor(ctx.cursor);
  const rows = await ctx.store.anonymousReportsBefore(before, cursor, CHUNK_SIZE);
  const nowIso = isoAt(ctx.now);
  let last = cursor;
  let processed = 0;
  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    if (outOfTime(ctx)) return { done: false, cursor: last, processed };
    const batch = rows.slice(i, i + WRITE_BATCH);
    const patches = batch
      .map((r): PointPatch | null => {
        const snapped = coarsenedPoint(r);
        return samePoint(snapped, r) ? null : { id: r.id, lat: snapped.lat, lng: snapped.lng };
      })
      .filter((p): p is PointPatch => p !== null);
    if (patches.length > 0) await ctx.store.savePoints(patches, nowIso);
    processed += patches.length;
    const tail = batch[batch.length - 1];
    last = { created_at: tail.created_at, id: tail.id };
  }
  const done = rows.length < CHUNK_SIZE;
  return { done, cursor: done ? null : last, processed };
};
