/**
 * autoVerify (plan §11, nightly): a report completed more than AUTO_VERIFY_DAYS ago with no resident verdict
 * (no verification row) becomes verified, with a system report_event that says so — "14 days of silence" is the
 * second way a fix is confirmed (docs/data-sources.md "Verification of fixes"). Reports with a verdict are left to
 * the verification flow (two confirmations → verified; a rejection reopens). Chunked over an id keyset cursor; rows
 * are re-checked for status at write time so a verdict that lands mid-run wins.
 */
import { DAY_MS } from '@/domain/time';

import { CHUNK_SIZE, idCursor, isoAt, outOfTime, type JobFn } from './types';

export const AUTO_VERIFY_DAYS = 14; // spec: plan §11 "completed > 14 d without verdict → verified"
export const AUTO_VERIFY_NOTE = 'auto-verified after 14 days'; // spec: plan §11 event text

export const autoVerify: JobFn = async (ctx) => {
  const before = isoAt(ctx.now - AUTO_VERIFY_DAYS * DAY_MS);
  const cursor = idCursor(ctx.cursor);
  const rows = await ctx.store.completedBefore(before, cursor, CHUNK_SIZE);
  const nowIso = isoAt(ctx.now);
  let last = cursor;
  let processed = 0;
  for (const row of rows) {
    if (outOfTime(ctx)) return { done: false, cursor: last, processed };
    if (!row.has_verdict && (await ctx.store.markAutoVerified(row.id, nowIso, AUTO_VERIFY_NOTE))) processed++;
    last = { id: row.id };
  }
  const done = rows.length < CHUNK_SIZE;
  return { done, cursor: done ? null : last, processed };
};
