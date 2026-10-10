/**
 * Report lifecycle core (spec status-mapping table lines 2098–2110; §4.4 verification lines 2260–2265; plan §4 flow 6,
 * §7 PATCH /reports/:id and POST /reports/:id/verify). The one place a report's status changes outside the jobs:
 * changeStatus() for staff — shared by the PATCH route and scripts/set-status.ts, the DPW console stand-in — and
 * recordVerdict() for residents. Both validate with domain/status.transition(), write the row and its report_event
 * through the LifecycleRepo, then push to the reporter and followers (server/notify.ts). A reopen starts a new
 * completion cycle: the tallies and the one-verdict rule read only the verdicts since the latest `completed` event,
 * and completing again needs an after-photo newer than the reopen. HTTP-free: failures carry the status and code
 * the route answers with, so the script can print the same words. Server-only module.
 */
import { DEFAULT_WEIGHTS, effectiveSeverity, scoreFromTerms, severityTerm } from '@/domain/score';
import { RESIDENT_WORDING, transition, type Actor } from '@/domain/status';
import type { ReportStatus, Role, SeverityBand, StatusPatchInput, VerifyInput } from '@/domain/types';

import type { ErrorCode } from './http';
import { logEvent } from './log';
import { notifyStatusChange } from './notify';
import { getLifecycleRepo, type StatusPatch, type Verdict } from './repos/lifecycle';
import { getPhotosRepo, type PhotoRow } from './repos/photos';
import { getRepos, type ReportRow } from './repos/types';

/** Who moves the report: a signed-in staff account, or a script acting as the supervisor with no user id. */
export interface StaffActor {
  role: Role;
  userId: string | null;
}

export interface ResidentActor {
  userId: string;
}

export interface LifecycleFailure {
  ok: false;
  status: 403 | 404 | 409 | 422;
  code: ErrorCode;
  message: string;
}

export type ChangeStatusResult = { ok: true; row: ReportRow; from: ReportStatus } | LifecycleFailure;
export type VerdictResult = { ok: true; row: ReportRow; verdict: Verdict; confirmations: number; rejections: number; created: boolean } | LifecycleFailure;

export const VERIFIED_NOTE = 'Fix confirmed by residents'; // spec: §4.4 line 2263 — 2 confirmations → verified
export const REOPEN_NOTE = 'Resident reports the fix did not hold — reopened'; // spec: §4.4 line 2264 — 1 rejection with photo → reopen
export const SEVERITY_CAP: SeverityBand = 4; // spec: §4.4 line 2264 "escalate one severity band" — band 4 is the top

const fail = (status: LifecycleFailure['status'], code: ErrorCode, message: string): LifecycleFailure => ({ ok: false, status, code, message });

/** The band plus the severity term and score that follow it, so the shown score always matches its terms (plan §8). */
function severityPatch(row: ReportRow, band: SeverityBand): Pick<StatusPatch, 'severity_confirmed' | 'score' | 'score_terms'> {
  const terms = { ...row.score_terms, severity: severityTerm(band) };
  return { severity_confirmed: band, score: scoreFromTerms(terms, DEFAULT_WEIGHTS, row.storm_multiplier), score_terms: terms };
}

/** Spec §4.4 "escalate one severity band": the effective band + 1, capped, written as severity_confirmed so it sticks. */
export function escalatedBand(row: Pick<ReportRow, 'severity_confirmed' | 'severity_ai' | 'severity_resident'>): SeverityBand {
  const current = effectiveSeverity({ confirmed: row.severity_confirmed, ai: row.severity_ai, resident: row.severity_resident });
  return Math.min(SEVERITY_CAP, current + 1) as SeverityBand;
}

/** A pending upload becomes this report's photo in `phase`; a photo already on this report passes (a staff retry); anything else is refused. The verify path refuses an attached photo before calling this. */
async function claimPhoto(photo: PhotoRow, reportId: string, phase: PhotoRow['phase'], uploaderId: string | null): Promise<LifecycleFailure | null> {
  if (photo.report_id === reportId) return null;
  if (photo.report_id !== null) return fail(409, 'conflict', 'That photo is already attached to another report.');
  if (uploaderId !== null && photo.uploader_id !== uploaderId) return fail(403, 'forbidden', 'That photo was uploaded by another account.');
  await getPhotosRepo().attach([photo.id], { reportId, anonymous: false, phase });
  return null;
}

/**
 * Staff move (plan §4 flow 6): capability and evidence checked by transition() — 409 when the move itself is not
 * open to this actor from the current status, 422 when it is but the evidence is missing (after-photo, rejection
 * reason). `afterPhotoId` may be a pending upload (attached here as `after`) or a photo already on the report.
 * After a reopen the rejected fix's after-photo is no longer evidence: `completed` then needs the pending upload
 * this call attaches or an after-photo uploaded since the latest move out of `completed` (spec 4.4 "crew marks
 * complete + after-photo" holds for every fix, not only the first).
 */
export async function changeStatus(reportId: string, input: StatusPatchInput, actor: StaffActor, opts: { now?: string } = {}): Promise<ChangeStatusResult> {
  const now = opts.now ?? new Date().toISOString();
  const repos = getRepos();
  const row = reportId ? await repos.reports.getPublicById(reportId) : null;
  if (!row) return fail(404, 'not_found', 'No such report.');
  const staff: Actor = { role: actor.role };
  const note = input.note?.trim() || null;
  // The move itself first, with every evidence assumed present: a denial here is a state or role conflict.
  const move = transition(row.status, input.to, staff, { hasAfterPhoto: true, reason: 'assumed' });
  if (!move.ok) return fail(409, 'invalid_transition', `Cannot move this report to “${RESIDENT_WORDING[input.to]}”: ${move.reason}.`);

  const photos = getPhotosRepo();
  let attachedNow = false;
  if (input.afterPhotoId) {
    const photo = await photos.get(input.afterPhotoId);
    if (!photo) return fail(404, 'not_found', 'No such after-photo. Upload it first.');
    attachedNow = photo.report_id === null;
    const refused = await claimPhoto(photo, row.id, 'after', null);
    if (refused) return refused;
  }
  // Only evidence of the current fix counts: after a reopen, an after-photo uploaded before it belongs to the rejected fix.
  const reopenedAt = [...row.events].reverse().find((e) => e.from_status === 'completed')?.created_at;
  const hasAfterPhoto = attachedNow || (await photos.listByReport(row.id)).some((p) => p.phase === 'after' && (reopenedAt === undefined || p.created_at >= reopenedAt));
  const evidence = transition(row.status, input.to, staff, { hasAfterPhoto, reason: note ?? undefined });
  if (!evidence.ok) return fail(422, 'invalid_transition', `This move needs more: ${evidence.reason}.`);

  const lifecycle = getLifecycleRepo();
  const severity = input.severityConfirmed !== undefined && input.severityConfirmed !== row.severity_confirmed ? severityPatch(row, input.severityConfirmed) : {};
  await lifecycle.setStatus(row.id, { status: input.to, updated_at: now, ...severity });
  if (severity.severity_confirmed !== undefined) {
    await lifecycle.appendSeverityAudit({ report_id: row.id, ai_value: row.severity_ai, human_value: severity.severity_confirmed, inspector_id: actor.userId, reason: note ?? `confirmed at ${input.to}`, created_at: now });
  }
  await lifecycle.appendEvent(row.id, { kind: 'status', actor_type: 'staff', actor_id: actor.userId, from_status: row.status, to_status: input.to, note, created_at: now });
  const after = (await repos.reports.getPublicById(row.id)) ?? row;
  await notifyStatusChange(after, row.status, input.to, { now: Date.parse(now) });
  return { ok: true, row: after, from: row.status };
}

/**
 * Resident verdict (spec §4.4): only a `completed` report takes one; one per account per completion — a replay
 * answers with the stored verdict and the current tallies, no second row. The rule and the tallies read only the
 * rows since the latest `completed` status event (the bound jobs.ts completedAt uses), so a reopened and
 * re-completed report starts from zero and every account may answer about the new fix. VERIFY_CONFIRMATIONS
 * confirmations → `verified`; REOPEN_REJECTIONS rejection(s) with a photo → back to `assessed` one band higher. A
 * bare rejection is recorded for the inspector and changes nothing else. The photo, when given, must be the
 * resident's own pending upload — a photo already on a report (the intake photo, the after-photo) is refused with
 * 409 — and becomes this report's `before` evidence.
 */
export async function recordVerdict(reportId: string, input: VerifyInput, actor: ResidentActor, opts: { now?: string } = {}): Promise<VerdictResult> {
  const now = opts.now ?? new Date().toISOString();
  const repos = getRepos();
  const lifecycle = getLifecycleRepo();
  const row = reportId ? await repos.reports.getPublicById(reportId) : null;
  if (!row) return fail(404, 'not_found', 'No such report.');
  // The current completion cycle: verdicts before the latest `completed` event answered a fix that was rejected since.
  const since = [...row.events].reverse().find((e) => e.to_status === 'completed')?.created_at ?? row.created_at;
  const existing = await lifecycle.getVerdictByUser(row.id, actor.userId, since);
  if (existing) {
    const tally = await lifecycle.countVerdicts(row.id, since);
    return { ok: true, row, verdict: existing.verdict, confirmations: tally.confirmations, rejections: tally.rejections, created: false };
  }
  if (row.status !== 'completed') return fail(409, 'invalid_transition', `Only a report marked “${RESIDENT_WORDING.completed}” can be verified; this one is “${RESIDENT_WORDING[row.status]}”.`);

  let photoId: string | null = null;
  if (input.photoId) {
    const photo = await getPhotosRepo().get(input.photoId);
    if (!photo) return fail(404, 'not_found', 'No such photo. Upload it first.');
    if (photo.report_id !== null) return fail(409, 'conflict', 'That photo is already on a report. Upload a new photo of the hazard.');
    const refused = await claimPhoto(photo, row.id, 'before', actor.userId);
    if (refused) return refused;
    photoId = photo.id;
  }
  const note = input.note?.trim() || null;
  await lifecycle.addVerification({ report_id: row.id, user_id: actor.userId, verdict: input.verdict, photo_id: photoId, created_at: now });
  await lifecycle.appendEvent(row.id, { kind: 'verification', actor_type: 'resident', actor_id: actor.userId, from_status: null, to_status: null, note: verdictNote(input.verdict, photoId !== null, note), created_at: now });
  const tally = await lifecycle.countVerdicts(row.id, since);

  const system: Actor = { role: 'system' };
  const to: ReportStatus | null =
    input.verdict === 'confirmed' && transition('completed', 'verified', system, { hasAfterPhoto: true, confirmations: tally.confirmations }).ok
      ? 'verified'
      : input.verdict === 'rejected' && transition('completed', 'assessed', system, { hasAfterPhoto: true, rejections: tally.rejectionsWithPhoto }).ok
        ? 'assessed'
        : null;
  if (!to) return { ok: true, row, verdict: input.verdict, confirmations: tally.confirmations, rejections: tally.rejections, created: true };

  const escalation = to === 'assessed' ? severityPatch(row, escalatedBand(row)) : {};
  await lifecycle.setStatus(row.id, { status: to, updated_at: now, ...escalation });
  if (escalation.severity_confirmed !== undefined) {
    await lifecycle.appendSeverityAudit({ report_id: row.id, ai_value: row.severity_ai, human_value: escalation.severity_confirmed, inspector_id: null, reason: REOPEN_NOTE, created_at: now });
    // Spec §4.4 "notify supervisor": the supervisor page arrives with the console; the reopen is logged so it is visible meanwhile.
    logEvent('info', 'lifecycle.reopened', { reportId: row.id, severity: escalation.severity_confirmed });
  }
  await lifecycle.appendEvent(row.id, { kind: 'status', actor_type: 'system', actor_id: null, from_status: 'completed', to_status: to, note: to === 'verified' ? VERIFIED_NOTE : REOPEN_NOTE, created_at: now });
  const after = (await repos.reports.getPublicById(row.id)) ?? row;
  await notifyStatusChange(after, 'completed', to, { now: Date.parse(now) });
  return { ok: true, row: after, verdict: input.verdict, confirmations: tally.confirmations, rejections: tally.rejections, created: true };
}

/** Timeline wording for one verdict; the resident's note follows when given (moderated by the route, like comments). */
export function verdictNote(verdict: Verdict, withPhoto: boolean, note: string | null): string {
  const base = verdict === 'confirmed' ? 'A resident confirmed the fix' : withPhoto ? 'A resident reports the hazard is still there, with a photo' : 'A resident reports the hazard is still there';
  return note ? `${base} — ${note}` : base;
}
