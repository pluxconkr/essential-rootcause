/**
 * Ids: time-ordered, URL-safe, no dependency. `newId('d')` → "d_m2k9x1a3_7f3kq". Drafts use these as the
 * idempotency key the server stores in report.client_draft_id. Pure module.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function rand(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

export function newId(prefix: string, now: number = Date.now()): string {
  return `${prefix}_${now.toString(36)}_${rand(6)}`;
}

/** Work-order style display id for a report: "WO-2026-0418" (year of creation + 4-digit sequence). */
export function workOrderLabel(createdAt: string | number, seq: number): string {
  const year = new Date(typeof createdAt === 'number' ? createdAt : Date.parse(createdAt)).getUTCFullYear();
  return `WO-${year}-${String(seq % 10_000).padStart(4, '0')}`;
}
