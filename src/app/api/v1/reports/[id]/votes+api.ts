/**
 * /api/v1/reports/[id]/votes (plan §7 "POST/DELETE · resident · 60/h · one per account; geo check; weight"; §4 flow 5;
 * spec §4.3).
 *   POST   VoteInput {lat?, lng?} → 201 VoteResponse; the same account again → 409 (one vote per account is the
 *          report_vote primary key). Weight = domain/votes voteWeight({accountAgeDays, hasHomeArea}) — 0.6 for an
 *          account under 7 days old or without a home watch area, else 1.0. The geo check compares the voter's point
 *          (the device fix sent in the body, else the home area) with the report and flags unverified_geo beyond
 *          1.5 km; the vote still counts. The community term is recomputed from Σ vote weight with the stored
 *          exposure, liability and decay terms (repos/derive.ts rescoreForVotes), 25 and 100 votes set flags.supervisor_review /
 *          council_item once each and append a report_event, and the voter auto-follows the report (plan §6).
 *   DELETE → 200 VoteResponse with voted=false, idempotent: an unvote replayed from the phone's queue must not fail.
 *          Threshold flags stay set — they record that review was triggered, and staff clear them.
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import type { z } from 'zod';

import type { Action } from '@/domain/roles';
import { daysBetween } from '@/domain/time';
import { VoteInputSchema, type ScoreTerms, type VoteResponse } from '@/domain/types';
import { geoCheck, thresholdFlags, VOTE_THRESHOLDS, voteWeight } from '@/domain/votes';
import { requireCapability, requireUser, type AuthedUser } from '@/server/auth';
import { error, json, type Parsed, withTiming, zodMessage } from '@/server/http';
import { getRateLimiter, keyFor } from '@/server/ratelimit';
import { rescoreForVotes } from '@/server/repos/derive';
import { getEngagementRepo } from '@/server/repos/engagement';
import { getRepos, type ReportRow } from '@/server/repos/types';

export const VOTE_LIMIT = {
  perWindow: 60, // spec: plan §7 POST/DELETE /api/v1/reports/:id/votes 60/h
  windowSec: 3600,
} as const;

/** Residents and up may vote; auditors are refused (spec §11, plan §12). */
export const VOTE_ACTION: Action = 'vote';

/** An empty body means "no device fix" — the phone may vote from a list without a location. */
async function parseOptionalJson<S extends z.ZodType>(request: Request, schema: S): Promise<Parsed<z.output<S>>> {
  let raw: unknown = {};
  const text = (await request.text()).trim();
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, response: error(400, 'bad_request', 'Body must be JSON.') };
    }
  }
  const result = schema.safeParse(raw);
  if (!result.success) return { ok: false, response: error(400, 'bad_request', `Invalid request. ${zodMessage(result.error)}`) };
  return { ok: true, data: result.data };
}

/** Session and capability, as in POST /api/v1/reports. */
async function authenticate(request: Request): Promise<AuthedUser | Response> {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  return requireCapability(user, VOTE_ACTION) ?? user;
}

/** Votes and unvotes share one hourly bucket per account. */
async function limit(user: AuthedUser): Promise<Response | null> {
  const allowed = await getRateLimiter().hit(keyFor(['votes', user.userId]), VOTE_LIMIT.perWindow, VOTE_LIMIT.windowSec);
  return allowed ? null : error(429, 'rate_limited', 'You have voted many times this hour. Try again later.', { headers: { 'retry-after': String(VOTE_LIMIT.windowSec) } });
}

async function loadReport(params: Record<string, string>): Promise<ReportRow | Response> {
  const id = params.id?.trim() ?? '';
  const row = id ? await getRepos().reports.getPublicById(id) : null;
  return row ?? error(404, 'not_found', 'No such report.');
}

const voteResponse = (row: ReportRow, voteCount: number, voted: boolean, score: number, terms: ScoreTerms): VoteResponse => ({ reportId: row.id, voteCount, voted, score, scoreTerms: terms });

const handlePost = withTiming('POST /api/v1/reports/[id]/votes', async (request, ctx) => {
  const user = await authenticate(request);
  if (user instanceof Response) return user;
  const parsed = await parseOptionalJson(request, VoteInputSchema);
  if (!parsed.ok) return parsed.response;
  const limited = await limit(user);
  if (limited) return limited;
  const row = await loadReport(ctx.params);
  if (row instanceof Response) return row;
  const engagement = getEngagementRepo();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const account = await engagement.userContext(user.userId);
  const weight = voteWeight({ accountAgeDays: account ? daysBetween(account.created_at, now) : 0, hasHomeArea: account?.home != null });
  const voterPoint = parsed.data.lat !== undefined && parsed.data.lng !== undefined ? { lat: parsed.data.lat, lng: parsed.data.lng } : (account?.home ?? null);
  const geo = geoCheck(voterPoint, { lat: row.lat, lng: row.lng });

  const created = await engagement.addVote({ report_id: row.id, user_id: user.userId, weight, unverified_geo: geo.unverifiedGeo, install_id: request.headers.get('x-install-id')?.trim() || null, created_at: nowIso });
  if (!created) return error(409, 'conflict', 'You have already voted on this report.');

  const voteCount = row.vote_count + 1;
  const { score, terms } = rescoreForVotes(row, await engagement.voteWeightSum(row.id));
  const flags = { ...row.flags };
  const reached = thresholdFlags(voteCount);
  if (reached.supervisorReview && !flags.supervisor_review) {
    flags.supervisor_review = true;
    await engagement.appendEvent(row.id, { kind: 'threshold_supervisor_review', actor_type: 'system', actor_id: null, from_status: null, to_status: null, note: `${VOTE_THRESHOLDS.supervisorReview} urgency votes — flagged for supervisor review`, created_at: nowIso });
  }
  if (reached.councilItem && !flags.council_item) {
    flags.council_item = true;
    await engagement.appendEvent(row.id, { kind: 'threshold_council_item', actor_type: 'system', actor_id: null, from_status: null, to_status: null, note: `${VOTE_THRESHOLDS.councilItem} urgency votes — flagged as a council item`, created_at: nowIso });
  }
  await engagement.updateCounters(row.id, { vote_count: voteCount, score, score_terms: terms, flags, updated_at: nowIso });
  await engagement.follow(row.id, user.userId, nowIso); // voters auto-follow (plan §6 report_follow)
  return json(voteResponse(row, voteCount, true, score, terms), { status: 201 });
});

const handleDelete = withTiming('DELETE /api/v1/reports/[id]/votes', async (request, ctx) => {
  const user = await authenticate(request);
  if (user instanceof Response) return user;
  const limited = await limit(user);
  if (limited) return limited;
  const row = await loadReport(ctx.params);
  if (row instanceof Response) return row;
  const engagement = getEngagementRepo();
  const removed = await engagement.removeVote(row.id, user.userId);
  if (!removed) return json(voteResponse(row, row.vote_count, false, row.score, row.score_terms));
  const voteCount = Math.max(0, row.vote_count - 1);
  const { score, terms } = rescoreForVotes(row, await engagement.voteWeightSum(row.id));
  await engagement.updateCounters(row.id, { vote_count: voteCount, score, score_terms: terms, flags: row.flags, updated_at: new Date().toISOString() });
  return json(voteResponse(row, voteCount, false, score, terms));
});

export async function POST(request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handlePost(request, params);
}

export async function DELETE(request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handleDelete(request, params);
}
