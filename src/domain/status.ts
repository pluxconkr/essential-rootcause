/**
 * Status machine — the 8 statuses, who may move a report between them and what evidence each move needs
 * (spec status-mapping table lines 2098–2110; §4.4 verification lines 2260–2265; plan §1.3, Appendix B).
 * Pure module: no React Native or Expo imports. The same transition() runs on the server
 * (PATCH /reports/:id → 422 on denial) and in the console (O3 drawer offers only the moves the role can make).
 * `verified` and the reopen to `assessed` are system moves driven by resident verification — no staff role
 * sets them by hand. "In progress" is an event, not a status (types.ts).
 */
import { can, type Action } from './roles';
import { REPORT_STATUSES, type ReportStatus, type Role } from './types';

export interface Actor {
  role: Role | 'system';
}

export interface TransitionCtx {
  /** An after-photo is attached — completing needs one (spec 4.4 "crew marks complete + after-photo"). */
  hasAfterPhoto: boolean;
  /** Resident confirmations received on a completed report. */
  confirmations?: number;
  /** Resident rejections that carried a photo — a bare rejection does not reopen (spec 4.4 line 2264). */
  rejections?: number;
  /** 14 days of silence (spec 4.4 line 2265) — set only by the autoVerify job. */
  autoVerify?: boolean;
  /** Required for `rejected`: the resident reads it ("Not city-owned — here's who owns it"). */
  reason?: string;
}

export type TransitionResult = { ok: true } | { ok: false; reason: string };

export const VERIFY_CONFIRMATIONS = 2; // spec: §4.4 line 2263
export const REOPEN_REJECTIONS = 1; // spec: §4.4 line 2264 — one rejection with photo reopens
export const AUTO_VERIFY_DAYS = 14; // spec: §4.4 line 2265

/** Open311 GeoReport v2 status for each RootCause status. */
export const OPEN311_STATUS = {
  new: 'open', // spec: status table line 2103
  triaged: 'open', // spec: status table line 2104
  assessed: 'open', // spec: status table line 2105
  mitigated: 'open', // spec: status table line 2106
  scheduled: 'open', // spec: status table line 2107
  completed: 'closed', // spec: status table line 2108
  verified: 'closed', // spec: status table line 2109
  rejected: 'closed', // spec: status table line 2110
} as const satisfies Record<ReportStatus, 'open' | 'closed'>;

/**
 * Vendor (Cityworks) status for each RootCause status — the spec's example column, kept here so the WorkOrderSync
 * seam has one table to read when the adapter ships in Phase 2 (plan §3.11, D10). Both closed states map to WO/CLOSED.
 */
export const CITYWORKS_STATUS = {
  new: 'REQUEST', // spec: status table line 2103
  triaged: 'REQUEST/REVIEWED', // spec: status table line 2104
  assessed: 'WO/CREATED', // spec: status table line 2105
  mitigated: 'WO/TEMP', // spec: status table line 2106
  scheduled: 'WO/SCHEDULED', // spec: status table line 2107
  completed: 'WO/CLOSED', // spec: status table line 2108
  verified: 'WO/CLOSED', // spec: status table line 2109
  rejected: 'REQUEST/CANCEL', // spec: status table line 2110
} as const satisfies Record<ReportStatus, string>;

/** Resident-facing wording (spec status table; plan Appendix B). */
export const RESIDENT_WORDING = {
  new: 'Received', // spec: status table line 2103
  triaged: 'Confirmed by inspector', // spec: status table line 2104
  assessed: 'Assessed in the field', // spec: status table line 2105
  mitigated: 'Made safe temporarily', // spec: status table line 2106
  scheduled: 'Scheduled — window given', // spec: status table line 2107
  completed: 'Fixed — please verify', // spec: status table line 2108
  verified: 'Fix confirmed by a resident', // spec: status table line 2109
  rejected: "Not city-owned — here's who owns it", // spec: status table line 2110
} as const satisfies Record<ReportStatus, string>;

export function isOpen(status: ReportStatus): boolean {
  return OPEN311_STATUS[status] === 'open';
}

interface StaffMove {
  from: readonly ReportStatus[];
  to: ReportStatus;
  action: Action;
  needsAfterPhoto?: boolean;
}

/** Staff moves (plan §1.3 / task table). Rejection is handled separately: any open status, inspector+, with a reason. */
const STAFF_MOVES: readonly StaffMove[] = [
  { from: ['new'], to: 'triaged', action: 'triage' },
  { from: ['triaged'], to: 'assessed', action: 'confirm_severity' },
  { from: ['assessed'], to: 'mitigated', action: 'mitigate' },
  { from: ['assessed', 'mitigated'], to: 'scheduled', action: 'schedule' },
  { from: ['assessed', 'mitigated', 'scheduled'], to: 'completed', action: 'complete', needsAfterPhoto: true },
];

const OK: TransitionResult = { ok: true };
const deny = (reason: string): TransitionResult => ({ ok: false, reason });

export function transition(from: ReportStatus, to: ReportStatus, actor: Actor, ctx: TransitionCtx): TransitionResult {
  if (from === to) return deny(`already ${to}`);
  if (actor.role === 'system') return systemMove(from, to, ctx);
  if (to === 'verified') return deny('verified is set by resident confirmation, not by staff');
  if (to === 'rejected') {
    if (!isOpen(from)) return deny(`a ${from} report is closed and cannot be rejected`);
    if (!can(actor.role, 'triage')) return deny(`${actor.role} cannot reject reports`);
    if (!ctx.reason?.trim()) return deny('a rejection needs a reason the resident will see');
    return OK;
  }
  const move = STAFF_MOVES.find((m) => m.to === to && m.from.includes(from));
  if (!move) return deny(`no move from ${from} to ${to}`);
  if (!can(actor.role, move.action)) return deny(`${actor.role} cannot ${move.action}`);
  if (move.needsAfterPhoto && !ctx.hasAfterPhoto) return deny('completing needs an after-photo');
  return OK;
}

function systemMove(from: ReportStatus, to: ReportStatus, ctx: TransitionCtx): TransitionResult {
  if (from !== 'completed') return deny('the system only verifies or reopens completed reports');
  if (to === 'verified') {
    if ((ctx.confirmations ?? 0) >= VERIFY_CONFIRMATIONS || ctx.autoVerify === true) return OK;
    return deny(`verified needs ${VERIFY_CONFIRMATIONS} confirmations or ${AUTO_VERIFY_DAYS} days of silence`);
  }
  if (to === 'assessed') {
    if ((ctx.rejections ?? 0) >= REOPEN_REJECTIONS) return OK;
    return deny('reopening needs a rejection with a photo');
  }
  return deny(`the system cannot move a completed report to ${to}`);
}

/** The statuses this actor may move the report to right now (O3 drawer buttons). */
export function nextStatuses(from: ReportStatus, actor: Actor, ctx: TransitionCtx): ReportStatus[] {
  return REPORT_STATUSES.filter((to) => transition(from, to, actor, ctx).ok);
}
