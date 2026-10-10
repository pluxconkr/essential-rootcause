/**
 * POST /api/v1/reports/[id]/verify (plan §7 "reporter or follower · confirm/reject with optional photo"; spec §4.4
 * lines 2260–2265). VerifyInput {verdict, photoId?, note?} → 201 VerifyResponse {report, verdict, confirmations,
 * rejections}; a replay from the phone's queue answers 200 with the stored verdict and the current tallies (one
 * verdict per account per report). Needs a session (D3) and the `verify` capability (spec §11: residents and up,
 * never auditors). Only a `completed` report takes a verdict — 409 invalid_transition otherwise. The rules live in
 * server/lifecycle.recordVerdict(): VERIFY_CONFIRMATIONS confirmations → `verified`; one rejection with a photo →
 * reopened to `assessed` one band higher; a bare rejection is recorded and changes nothing else. The note goes on
 * the public timeline, so it passes the same filter as a comment (links, profanity → 400).
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import { moderateComment } from '@/domain/moderation';
import type { Action } from '@/domain/roles';
import { VerifyInputSchema, type VerifyResponse } from '@/domain/types';
import { requireCapability, requireUser } from '@/server/auth';
import { error, json, parseJson, withTiming } from '@/server/http';
import { recordVerdict } from '@/server/lifecycle';
import { toPublicReport } from '@/server/public';
import { getRepos } from '@/server/repos/types';

export const VERIFY_ACTION: Action = 'verify';

const handlePost = withTiming('POST /api/v1/reports/[id]/verify', async (request, { params }) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  const denied = requireCapability(user, VERIFY_ACTION);
  if (denied) return denied;
  const parsed = await parseJson(request, VerifyInputSchema);
  if (!parsed.ok) return parsed.response;
  if (parsed.data.note?.trim()) {
    const filtered = moderateComment(parsed.data.note);
    if (!filtered.ok) return error(400, 'bad_request', filtered.message);
  }
  const result = await recordVerdict(params.id?.trim() ?? '', parsed.data, { userId: user.userId });
  if (!result.ok) return error(result.status, result.code, result.message);
  const body: VerifyResponse = { report: toPublicReport(result.row), verdict: result.verdict, confirmations: result.confirmations, rejections: result.rejections };
  return json(body, { status: result.created ? 201 : 200 });
});

export async function POST(request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handlePost(request, params);
}
