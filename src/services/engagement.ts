/**
 * Votes, comments, follows and flags from the phone (spec §4.3; plan §9.2 mutations queue "optimistic UI and server
 * reconciliation; requires a session", §7 routes). Every action asks for a session first (null → {ok: false, reason:
 * 'sign_in'} and nothing changes), applies the optimistic change to the store (votedIds / followedIds and the counter
 * on the cached report), then: online → calls the route and reconciles from its answer; offline, or on a transient
 * failure → queues a mutation (mutations:v1) that flushMutations() replays in order with the drafts' retry policy —
 * retry on network error, 408, 429, 5xx; stop on 401 (sign in again); drop with the reason on 400/403/404/422 and roll
 * the optimistic change back. 409 on a vote means the server already has it — success. Demo reports (labelled, never
 * on the server) toggle locally and are never sent or queued. Nothing here throws.
 */
import { z } from 'zod';

import { mutationsRepo, type QueuedMutation } from '@/data/repos';
import { newId } from '@/domain/ids';
import { moderateComment } from '@/domain/moderation';
import { CommentSchema, CommentsResponseSchema, PublicReportSchema, VoteResponseSchema, type Comment, type FlagInput, type PublicReport, type VoteResponse } from '@/domain/types';
import { actions, getState, isOfflineNow } from '@/store/appStore';

import { api, type ApiResult } from './apiClient';
import { requireSession } from './auth';
import { ensurePermissionAndRegister } from './notifications';

export type EngagementFailure = 'sign_in' | 'offline' | 'rate_limited' | 'rejected' | 'network';

export type EngagementResult = { ok: true; queued: boolean } | { ok: false; reason: EngagementFailure; message: string };
export type CommentResult = { ok: true; queued: boolean; comment: Comment | null } | { ok: false; reason: EngagementFailure; message: string };

export interface FlushResult {
  sent: number;
  failed: number;
  skipped: number;
}

export const FollowResponseSchema = z.object({ reportId: z.string(), following: z.boolean() });
const FlagResponseSchema = z.object({ flagId: z.string(), status: z.string() });
const CommentCreatedSchema = z.object({ comment: CommentSchema });
/** GET /api/v1/reports/:id answers {report}; accept the bare shape too, so a route change cannot break the page. */
const ReportEnvelopeSchema = z.union([z.object({ report: PublicReportSchema }).transform((b) => b.report), PublicReportSchema]);

const MESSAGE: Record<EngagementFailure, string> = {
  sign_in: 'Sign in to continue.',
  offline: 'No signal. Try again when you are back online.',
  rate_limited: 'Too many in a short time. Try again later.',
  rejected: 'The server did not accept this.',
  network: 'No connection. Saved on this phone — sends when online.',
};

const fail = (reason: EngagementFailure, message?: string): { ok: false; reason: EngagementFailure; message: string } => ({ ok: false, reason, message: message ?? MESSAGE[reason] });

const path = (reportId: string, tail: string) => `/api/v1/reports/${encodeURIComponent(reportId)}/${tail}`;

// ---------- local report state ----------

function findReport(reportId: string): PublicReport | null {
  const s = getState();
  return s.demoReports.find((r) => r.id === reportId) ?? s.feed.find((r) => r.id === reportId) ?? null;
}

/** Patch the cached copy where it lives: demo reports stay in memory, live reports go back to the feed cache. */
export function patchReport(reportId: string, patch: Partial<PublicReport>): void {
  const s = getState();
  if (s.demoReports.some((r) => r.id === reportId)) {
    actions.setDemoReports(s.demoReports.map((r) => (r.id === reportId ? { ...r, ...patch } : r)));
    return;
  }
  const cached = s.feed.find((r) => r.id === reportId);
  if (cached) actions.upsertReport({ ...cached, ...patch });
}

function bumpCount(reportId: string, key: 'voteCount' | 'commentCount', delta: number): void {
  const r = findReport(reportId);
  if (r) patchReport(reportId, { [key]: Math.max(0, r[key] + delta) });
}

function applyVote(res: VoteResponse): void {
  actions.setVoted(res.reportId, res.voted);
  patchReport(res.reportId, { voteCount: res.voteCount, score: res.score, scoreTerms: res.scoreTerms });
}

// ---------- queue ----------

type Family = 'vote' | 'follow' | 'comment' | 'verify';

const familyOf = (kind: QueuedMutation['kind']): Family => (kind === 'vote' || kind === 'unvote' ? 'vote' : kind === 'follow' || kind === 'unfollow' ? 'follow' : kind);

/** Queue a mutation; a newer vote/follow toggle for the same report replaces the queued one, so two taps cancel out. */
function enqueue(m: QueuedMutation): void {
  const family = familyOf(m.kind);
  if (family === 'vote' || family === 'follow') for (const q of mutationsRepo.getAll()) if (q.reportId === m.reportId && familyOf(q.kind) === family) mutationsRepo.remove(q.id);
  mutationsRepo.enqueue(m);
}

export type Fate = 'done' | 'retry' | 'fail' | 'sign_in';

/** The drafts' retry policy (plan §9.2) applied to one answer. 409 = the server already has the vote/follow. */
export function fateOf(res: ApiResult<unknown>): Fate {
  if (res.ok || res.status === 409) return 'done';
  if (res.status === 401) return 'sign_in';
  if (res.status === 0 || res.status === 408 || res.status === 429 || (res.status >= 500 && res.status !== 501)) return 'retry';
  return 'fail';
}

// ---------- actions ----------

export async function vote(reportId: string, on: boolean): Promise<EngagementResult> {
  const session = await requireSession('vote');
  if (!session) return fail('sign_in');
  const report = findReport(reportId);
  const before = getState().votedIds.includes(reportId);
  if (before === on) return { ok: true, queued: false };
  actions.setVoted(reportId, on);
  bumpCount(reportId, 'voteCount', on ? 1 : -1);
  if (report?.isDemo) return { ok: true, queued: false };
  if (isOfflineNow()) {
    enqueue({ id: newId('m'), kind: on ? 'vote' : 'unvote', reportId, at: new Date().toISOString() });
    return { ok: true, queued: true };
  }
  const res = await sendVote(reportId, on);
  switch (fateOf(res)) {
    case 'done':
      if (res.ok) applyVote(res.data);
      else actions.setVoted(reportId, on); // 409: the server already holds this vote
      void ensurePermissionAndRegister();
      return { ok: true, queued: false };
    case 'retry':
      enqueue({ id: newId('m'), kind: on ? 'vote' : 'unvote', reportId, at: new Date().toISOString() });
      return { ok: true, queued: true };
    case 'sign_in':
      revertVote(reportId, before);
      return fail('sign_in');
    default:
      revertVote(reportId, before);
      return fail(res.ok ? 'rejected' : res.status === 429 ? 'rate_limited' : 'rejected', res.ok ? undefined : res.message);
  }
}

function sendVote(reportId: string, on: boolean): Promise<ApiResult<VoteResponse>> {
  const fix = getState().location;
  return api(path(reportId, 'votes'), VoteResponseSchema, on ? { method: 'POST', body: fix ? { lat: fix.lat, lng: fix.lng } : {} } : { method: 'DELETE' });
}

function revertVote(reportId: string, before: boolean): void {
  const now = getState().votedIds.includes(reportId);
  if (now === before) return;
  actions.setVoted(reportId, before);
  bumpCount(reportId, 'voteCount', before ? 1 : -1);
}

export async function follow(reportId: string, on: boolean): Promise<EngagementResult> {
  const session = await requireSession('follow');
  if (!session) return fail('sign_in');
  const report = findReport(reportId);
  const before = getState().followedIds.includes(reportId);
  if (before === on) return { ok: true, queued: false };
  actions.setFollowed(reportId, on);
  if (report?.isDemo) return { ok: true, queued: false };
  if (isOfflineNow()) {
    enqueue({ id: newId('m'), kind: on ? 'follow' : 'unfollow', reportId, at: new Date().toISOString() });
    return { ok: true, queued: true };
  }
  const res = await api(path(reportId, 'follow'), FollowResponseSchema, { method: on ? 'POST' : 'DELETE' });
  switch (fateOf(res)) {
    case 'done':
      actions.setFollowed(reportId, res.ok ? res.data.following : on);
      void ensurePermissionAndRegister();
      return { ok: true, queued: false };
    case 'retry':
      enqueue({ id: newId('m'), kind: on ? 'follow' : 'unfollow', reportId, at: new Date().toISOString() });
      return { ok: true, queued: true };
    case 'sign_in':
      actions.setFollowed(reportId, before);
      return fail('sign_in');
    default:
      actions.setFollowed(reportId, before);
      return fail('rejected', res.ok ? undefined : res.message);
  }
}

export async function comment(reportId: string, body: string): Promise<CommentResult> {
  const verdict = moderateComment(body);
  if (!verdict.ok) return fail('rejected', verdict.message);
  const session = await requireSession('comment');
  if (!session) return fail('sign_in');
  const text = body.trim();
  const report = findReport(reportId);
  if (report?.isDemo) {
    // Demo reports never reach the server: echo the comment locally so the demo flow reads end to end (labelled by the screen).
    return { ok: true, queued: false, comment: { id: newId('c'), body: text, authorDisplay: session.displayName ?? 'You', isStaff: false, at: new Date().toISOString() } };
  }
  if (isOfflineNow()) {
    enqueue({ id: newId('m'), kind: 'comment', reportId, body: text, at: new Date().toISOString() });
    bumpCount(reportId, 'commentCount', 1);
    return { ok: true, queued: true, comment: null };
  }
  const res = await api(path(reportId, 'comments'), CommentCreatedSchema, { method: 'POST', body: { body: text } });
  if (res.ok) {
    bumpCount(reportId, 'commentCount', 1);
    return { ok: true, queued: false, comment: res.data.comment };
  }
  switch (fateOf(res)) {
    case 'retry':
      enqueue({ id: newId('m'), kind: 'comment', reportId, body: text, at: new Date().toISOString() });
      bumpCount(reportId, 'commentCount', 1);
      return { ok: true, queued: true, comment: null };
    case 'sign_in':
      return fail('sign_in');
    default:
      return fail(res.status === 429 ? 'rate_limited' : 'rejected', res.message);
  }
}

/** Flags are online-only (not a queued mutation kind): a flag that cannot be sent is reported, not silently kept. */
export async function flag(target: { type: 'report' | 'comment'; id: string }, reason: FlagInput['reason'], note?: string): Promise<EngagementResult> {
  const session = await requireSession('comment');
  if (!session) return fail('sign_in');
  if (isOfflineNow()) return fail('offline');
  const body: FlagInput = note?.trim() ? { reason, note: note.trim() } : { reason };
  const res = await api(target.type === 'report' ? path(target.id, 'flag') : `/api/v1/comments/${encodeURIComponent(target.id)}/flag`, FlagResponseSchema, { method: 'POST', body });
  if (res.ok) return { ok: true, queued: false };
  if (res.status === 401) return fail('sign_in');
  if (res.status === 429) return fail('rate_limited', res.message);
  if (res.status === 0) return fail('network', MESSAGE.offline);
  return fail('rejected', res.message);
}

// ---------- reads ----------

export async function fetchComments(reportId: string): Promise<Comment[] | null> {
  const res = await api(path(reportId, 'comments'), CommentsResponseSchema);
  return res.ok ? res.data.comments : null;
}

/** One report by id (deep links, the public share page); null when unknown or unreachable. */
export async function fetchReport(reportId: string): Promise<{ report: PublicReport | null; status: number }> {
  const res = await api(`/api/v1/reports/${encodeURIComponent(reportId)}`, ReportEnvelopeSchema);
  return res.ok ? { report: res.data, status: res.status } : { report: null, status: res.status };
}

// ---------- replay ----------

async function replay(m: QueuedMutation): Promise<ApiResult<unknown>> {
  switch (m.kind) {
    case 'vote':
      return sendVote(m.reportId, true);
    case 'unvote':
      return sendVote(m.reportId, false);
    case 'follow':
      return api(path(m.reportId, 'follow'), FollowResponseSchema, { method: 'POST' });
    case 'unfollow':
      return api(path(m.reportId, 'follow'), FollowResponseSchema, { method: 'DELETE' });
    case 'comment':
      return api(path(m.reportId, 'comments'), CommentCreatedSchema, { method: 'POST', body: { body: m.body } });
    case 'verify':
      return api(path(m.reportId, 'verify'), z.unknown(), { method: 'POST', body: { verdict: m.verdict } });
  }
}

function reconcile(m: QueuedMutation, res: ApiResult<unknown>): void {
  if (m.kind === 'vote' || m.kind === 'unvote') {
    const parsed = res.ok ? VoteResponseSchema.safeParse(res.data) : null;
    if (parsed?.success) applyVote(parsed.data);
    else actions.setVoted(m.reportId, m.kind === 'vote');
  } else if (m.kind === 'follow' || m.kind === 'unfollow') actions.setFollowed(m.reportId, m.kind === 'follow');
}

/** Undo the optimistic change of a mutation the server refused for good. */
function rollBack(m: QueuedMutation): void {
  if (m.kind === 'vote' || m.kind === 'unvote') revertVote(m.reportId, m.kind === 'unvote');
  else if (m.kind === 'follow' || m.kind === 'unfollow') actions.setFollowed(m.reportId, m.kind === 'unfollow');
  else if (m.kind === 'comment') bumpCount(m.reportId, 'commentCount', -1);
}

let inFlight: Promise<FlushResult> | null = null;

/** Replay the queue in order. Stops at the first transient failure or 401 and leaves the rest for the next run. */
export function flushMutations(): Promise<FlushResult> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const result: FlushResult = { sent: 0, failed: 0, skipped: 0 };
    try {
      const queue = mutationsRepo.getAll();
      if (queue.length === 0) return result;
      if (isOfflineNow() || !getState().session) {
        result.skipped = queue.length;
        return result;
      }
      for (let i = 0; i < queue.length; i++) {
        const m = queue[i];
        const res = await replay(m);
        const fate = fateOf(res);
        if (fate === 'done') {
          mutationsRepo.remove(m.id);
          reconcile(m, res);
          result.sent += 1;
        } else if (fate === 'fail') {
          mutationsRepo.remove(m.id);
          rollBack(m);
          result.failed += 1;
        } else {
          result.skipped = queue.length - i;
          break;
        }
      }
      return result;
    } catch {
      return result;
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Queued mutations still waiting (S-12 shows the count). */
export function pendingMutations(): QueuedMutation[] {
  return mutationsRepo.getAll();
}
