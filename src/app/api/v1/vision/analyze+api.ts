/**
 * POST /api/v1/vision/analyze (plan §7, §3.6, §23.I; spec R4) — AnalyzeInput {photoId, lat, lng, subtypeHint?} →
 * AnalyzeResponse {proposals, reason, duplicates, model, exposure, adaRelevant, address}. Needs a session and a role
 * that may file reports, the photo must be this account's upload, and each account gets ANALYZE_LIMIT analyses a day
 * (DB-backed limiter, 429 with Retry-After); the tenant as a whole gets VISION_DAILY_MAX a day, after which the answer
 * is `reason: 'disabled'` (plan §23.I kill switch and budget, both required). Duplicates come from the reports repo's
 * find_duplicates within dupRadiusM of the hinted sub-type — or of every category's default sub-type when there is no
 * hint — mapped to DuplicateCandidate with the taxonomy title and the days open. Proposals come from
 * src/server/vision.ts (Claude, structured output, confidence floor); the raw answer is kept on report_photo.ai_json.
 * Exposure and the approximate address come from the bundled OSM extract (server/exposure.ts), the ADA line from the
 * taxonomy — the same inputs the score uses at insert, so what S-05 shows is what the server will compute.
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import type { Action } from '@/domain/roles';
import { CATEGORIES, defaultSubtype, subtypeDef } from '@/domain/taxonomy';
import { daysBetween } from '@/domain/time';
import { AnalyzeInputSchema, type AnalyzeInput, type AnalyzeResponse, type DuplicateCandidate } from '@/domain/types';
import { requireCapability, requireUser } from '@/server/auth';
import { error, json, parseJson, withTiming } from '@/server/http';
import { getServerEnv, isConfigured } from '@/server/env';
import { lookupExposure, reverseGeocode } from '@/server/exposure';
import { logEvent } from '@/server/log';
import { getRateLimiter, keyFor } from '@/server/ratelimit';
import { getPhotosRepo } from '@/server/repos/photos';
import { getRepos, type DuplicateCandidate as RepoCandidate, type Repos } from '@/server/repos/types';
import { VISION, analyzePhoto, visionEnabled, type AnalyzePhotoResult } from '@/server/vision';

export const ANALYZE_LIMIT = {
  perWindow: VISION.perUserPerDay, // spec: plan §7 POST /api/v1/vision/analyze 20/d
  windowSec: 86_400,
} as const;

/** Analysis is part of filing a report: residents and up, auditors refused (spec §11, plan §12). */
export const ANALYZE_ACTION: Action = 'report';

/** S-05 lists the nearest few candidates; find_duplicates itself caps at 20 rows. */
export const MAX_DUPLICATES = 5;

/** Tenant-wide daily budget (plan §23.I: VISION_DAILY_MAX and VISION_ENABLED are both required). Counted per UTC day. */
async function tenantBudgetOk(now: number): Promise<boolean> {
  if (!isConfigured()) return true; // tests and the memory dev server: no tenant budget to enforce
  const day = new Date(now).toISOString().slice(0, 10);
  return getRateLimiter().hit(keyFor(['vision:tenant', day]), getServerEnv().visionDailyMax, 86_400);
}

async function runVision(photo: { id: string; storage_key: string }, subtypeHint: AnalyzeInput['subtypeHint'], now: number): Promise<AnalyzePhotoResult> {
  const off: AnalyzePhotoResult = { proposals: null, reason: 'disabled', model: VISION.model, audit: null };
  if (!visionEnabled()) return off;
  if (!(await tenantBudgetOk(now))) {
    logEvent('warn', 'vision.daily_max_reached', { photoId: photo.id });
    return off;
  }
  const bytes = await getPhotosRepo().read(photo.storage_key);
  if (!bytes) {
    logEvent('error', 'vision.photo_missing', { photoId: photo.id });
    return { proposals: null, reason: 'error', model: VISION.model, audit: null };
  }
  const result = await analyzePhoto({ bytes, subtypeHint });
  if (result.audit) {
    try {
      await getPhotosRepo().setAnalysis(photo.id, result.audit, result.model);
    } catch (e) {
      logEvent('warn', 'vision.audit_write_failed', { photoId: photo.id, message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  return result;
}

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

  const now = Date.now();
  const duplicates = await duplicateCandidates(repos, input, now);
  const vision = await runVision(photo, input.subtypeHint, now);
  const exposure = lookupExposure(input.lat, input.lng);
  const address = reverseGeocode(input.lat, input.lng);
  const adaSubtype = vision.proposals?.subtype ?? input.subtypeHint ?? null;
  const body: AnalyzeResponse = {
    proposals: vision.proposals,
    reason: vision.reason,
    duplicates,
    model: vision.proposals ? vision.model : null,
    exposure: { pedsPerDay: exposure.pedsPerDay, roadName: exposure.roadName, flags: { schoolRoute: exposure.flags.schoolRoute, seniorFacility: exposure.flags.seniorFacility, transitStop: exposure.flags.transitStop } },
    adaRelevant: adaSubtype ? subtypeDef(adaSubtype).adaRelevant : null,
    address: address.text,
  };
  return json(body);
});

export async function POST(request: Request): Promise<Response> {
  return handlePost(request);
}
