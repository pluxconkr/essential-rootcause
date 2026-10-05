/**
 * POST /api/v1/vision/analyze (plan §7, §3.6, §23.I) — AnalyzeInput {photoId, lat, lng, subtypeHint?} → AnalyzeResponse
 * {proposals, reason, duplicates, model}. Needs a session and a role that may file reports, the photo must be this
 * account's upload, and each account gets ANALYZE_LIMIT analyses a day (DB-backed limiter, 429 with Retry-After).
 * Duplicates come from the reports repo's find_duplicates within dupRadiusM of the hinted sub-type — or of every
 * category's default sub-type when there is no hint — mapped to DuplicateCandidate with the taxonomy title and the
 * days open. Proposals come from the src/server/vision.ts seam, which returns null in M1, so the answer is
 * `{proposals: null, reason: 'disabled'}` and S-05 continues with the manual form (plan §15 "vision off → identical flow").
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import type { Action } from '@/domain/roles';
import { CATEGORIES, defaultSubtype, subtypeDef } from '@/domain/taxonomy';
import { daysBetween } from '@/domain/time';
import { AnalyzeInputSchema, type AnalyzeInput, type AnalyzeResponse, type DuplicateCandidate } from '@/domain/types';
import { requireCapability, requireUser } from '@/server/auth';
import { error, json, parseJson, withTiming } from '@/server/http';
import { getRateLimiter, keyFor } from '@/server/ratelimit';
import { getPhotosRepo } from '@/server/repos/photos';
import { getRepos, type DuplicateCandidate as RepoCandidate, type Repos } from '@/server/repos/types';
import { VISION, analyzePhoto, visionEnabled } from '@/server/vision';

export const ANALYZE_LIMIT = {
  perWindow: VISION.perUserPerDay, // spec: plan §7 POST /api/v1/vision/analyze 20/d
  windowSec: 86_400,
} as const;

/** Analysis is part of filing a report: residents and up, auditors refused (spec §11, plan §12). */
export const ANALYZE_ACTION: Action = 'report';

/** S-05 lists the nearest few candidates; find_duplicates itself caps at 20 rows. */
export const MAX_DUPLICATES = 5;

async function duplicateCandidates(repos: Repos, input: AnalyzeInput, now: number): Promise<DuplicateCandidate[]> {
  const subtypes = input.subtypeHint ? [input.subtypeHint] : CATEGORIES.map(defaultSubtype);
  const found = new Map<string, RepoCandidate>();
  for (const subtype of subtypes) for (const c of await repos.reports.findDuplicates(input.lat, input.lng, subtype)) if (!found.has(c.id)) found.set(c.id, c);
  const nearest = [...found.values()].sort((a, b) => a.distance_m - b.distance_m).slice(0, MAX_DUPLICATES);
  const out: DuplicateCandidate[] = [];
  for (const c of nearest) {
    const row = await repos.reports.getPublicById(c.id);
    if (!row) continue;
    out.push({ id: c.id, title: subtypeDef(c.subtype).label, subtype: c.subtype, status: c.status, voteCount: row.vote_count, distanceM: Math.round(c.distance_m * 10) / 10, daysOpen: daysBetween(row.created_at, now) });
  }
  return out;
}

const handlePost = withTiming('POST /api/v1/vision/analyze', async (request) => {
  const repos = getRepos();
  const user = await requireUser(request, repos);
  if (user instanceof Response) return user;
  const denied = requireCapability(user, ANALYZE_ACTION);
  if (denied) return denied;
  const parsed = await parseJson(request, AnalyzeInputSchema);
  if (!parsed.ok) return parsed.response;
  const input = parsed.data;

  const photo = await getPhotosRepo().get(input.photoId);
  if (!photo) return error(404, 'not_found', 'No such photo. Upload it first.');
  if (photo.uploader_id !== user.userId) return error(403, 'forbidden', 'That photo was uploaded by another account.');

  const allowed = await getRateLimiter().hit(keyFor(['vision:analyze', user.userId]), ANALYZE_LIMIT.perWindow, ANALYZE_LIMIT.windowSec);
  if (!allowed) return error(429, 'rate_limited', 'You have analysed many photos today. You can still file the report.', { headers: { 'retry-after': String(ANALYZE_LIMIT.windowSec) } });

  const duplicates = await duplicateCandidates(repos, input, Date.now());
  const proposals = visionEnabled() ? await analyzePhoto({ photoId: input.photoId, lat: input.lat, lng: input.lng, subtypeHint: input.subtypeHint }) : null;
  const body: AnalyzeResponse = { proposals, reason: proposals ? 'ok' : 'disabled', duplicates, model: proposals ? VISION.model : null };
  return json(body);
});

export async function POST(request: Request): Promise<Response> {
  return handlePost(request);
}
