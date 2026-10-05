/**
 * POST /api/v1/reports/[id]/photos (plan §7, §4 flow 4) — {photoId, phase} attaches one of this account's pending
 * uploads to an existing report → 201 {report, voted}.
 *   phase `before` (default): a resident adds evidence to an open report instead of filing a duplicate (spec 4.1
 *     "Add to that report"); it counts as their urgency vote — one per account, so a second photo adds no vote.
 *   phase `after`: completion evidence, inspector and up (status.ts needs it before `completed`).
 * Needs a session (D3) and the capability for the phase; the photo must be pending and this account's; the report
 * must exist and, for `before`, still be open (422 otherwise). ATTACH_LIMIT per account through the DB-backed limiter.
 * The uploader link stays on the photo: the attaching account is not the reporter, so plan §3.4 does not apply here.
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import { z } from 'zod';

import type { Action } from '@/domain/roles';
import { PHOTO_PHASES, type PhotoPhase } from '@/domain/types';
import { requireCapability, requireUser } from '@/server/auth';
import { error, json, parseJson, withTiming } from '@/server/http';
import { toPublicReport } from '@/server/public';
import { getRateLimiter, keyFor } from '@/server/ratelimit';
import { PHOTO_LIMITS, getPhotosRepo, photoAttacher } from '@/server/repos/photos';
import { getRepos } from '@/server/repos/types';

export const ATTACH_LIMIT = {
  perWindow: PHOTO_LIMITS.uploadsPerHour, // spec: plan §7 POST /api/v1/reports/:id/photos 20/h
  windowSec: 3600,
} as const;

/** Capability per phase (domain/roles): `before` is a vote, `after` is completion evidence (spec §11, plan §7). */
export const ATTACH_ACTION: Record<PhotoPhase, Action> = { before: 'vote', after: 'complete' };

const AttachInputSchema = z.object({
  photoId: z.string().min(1).max(64),
  phase: z.enum(PHOTO_PHASES).default('before'),
});

const handlePost = withTiming('POST /api/v1/reports/[id]/photos', async (request, ctx) => {
  const repos = getRepos();
  const user = await requireUser(request, repos);
  if (user instanceof Response) return user;
  const parsed = await parseJson(request, AttachInputSchema);
  if (!parsed.ok) return parsed.response;
  const input = parsed.data;
  const denied = requireCapability(user, ATTACH_ACTION[input.phase]);
  if (denied) return denied;
  const reportId = ctx.params.id?.trim() ?? '';
  if (!reportId) return error(404, 'not_found', 'No such report.');

  const photo = await getPhotosRepo().get(input.photoId);
  if (!photo) return error(404, 'not_found', 'No such photo. Upload it first.');
  if (photo.report_id !== null) return error(409, 'conflict', 'That photo is already attached to a report.');
  if (photo.uploader_id !== user.userId) return error(403, 'forbidden', 'That photo was uploaded by another account.');

  const allowed = await getRateLimiter().hit(keyFor(['photos:attach', user.userId]), ATTACH_LIMIT.perWindow, ATTACH_LIMIT.windowSec);
  if (!allowed) return error(429, 'rate_limited', 'You have added many photos this hour. Try again later.', { headers: { 'retry-after': String(ATTACH_LIMIT.windowSec) } });

  const reports = photoAttacher(repos);
  if (!reports) throw new Error('reports repo cannot attach photos');
  const result = await reports.attachPhoto(reportId, photo, { userId: user.userId, phase: input.phase, now: new Date().toISOString(), requestId: ctx.requestId });
  if (!result.ok) return result.reason === 'not_found' ? error(404, 'not_found', 'No such report.') : error(422, 'invalid_transition', 'That report is closed. File a new report instead.');
  return json({ report: toPublicReport(result.row), voted: result.voted }, { status: 201 });
});

export async function POST(request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handlePost(request, params);
}
