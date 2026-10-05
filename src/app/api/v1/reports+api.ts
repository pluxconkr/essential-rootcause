/**
 * /api/v1/reports (plan §7)
 *   GET  ?bbox&cat&status&sort&cursor&limit → {reports: PublicReport[], nextCursor}: the public feed and map source,
 *        every row through toPublicReport() (plan §12). Lists carry thumbnails and no timeline (plan §3.2).
 *   POST CreateReportInput → 201 {report}; a replay of the same clientDraftId → 200 with the original report
 *        (plan §4 flow 3). Needs a session (D3) and a role that may file reports (auditors are read-only, §12), and
 *        stays within CREATE_LIMIT per account through the DB-backed limiter (plan §3.10, 429 with Retry-After).
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import { z } from 'zod';

import { parseBBox } from '@/domain/geo';
import type { Action } from '@/domain/roles';
import { CATEGORIES, subtypeDef } from '@/domain/taxonomy';
import { CreateReportInputSchema, REPORT_STATUSES } from '@/domain/types';
import { requireCapability, requireUser } from '@/server/auth';
import { error, json, parseJson, withTiming, zodMessage } from '@/server/http';
import { toPublicReport } from '@/server/public';
import { getRateLimiter, keyFor } from '@/server/ratelimit';
import { getRepos } from '@/server/repos/types';

export const CREATE_LIMIT = {
  perWindow: 10, // spec: plan §7 POST /api/v1/reports 10/h (the 30/d tier joins with the daily window in M2)
  windowSec: 3600,
} as const;

export const LIST_LIMIT = { default: 50, max: 200 } as const;

/** Capability checked with domain/roles.can(): residents and up may file, auditors are refused (spec §11, plan §12). */
export const CREATE_ACTION: Action = 'report';

const ListQuerySchema = z.object({
  bbox: z.string().optional(),
  cat: z.enum(CATEGORIES).optional(),
  status: z.enum(REPORT_STATUSES).optional(),
  sort: z.enum(['score', 'newest']).default('score'),
  cursor: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT.max).default(LIST_LIMIT.default),
});

const handleGet = withTiming('GET /api/v1/reports', async (request) => {
  const params = Object.fromEntries(Array.from(new URL(request.url).searchParams).filter(([, v]) => v.trim() !== ''));
  const parsed = ListQuerySchema.safeParse(params);
  if (!parsed.success) return error(400, 'bad_request', `Invalid query. ${zodMessage(parsed.error)}`);
  const q = parsed.data;
  const bbox = q.bbox === undefined ? null : parseBBox(q.bbox);
  if (q.bbox !== undefined && !bbox) return error(400, 'bad_request', 'Invalid query. bbox: expected minLng,minLat,maxLng,maxLat');
  const repos = getRepos();
  const { rows, nextCursor } = await repos.reports.listPublic({ bbox, category: q.cat ?? null, status: q.status ?? null, sort: q.sort, cursor: q.cursor ?? null, limit: q.limit });
  return json({ reports: rows.map(toPublicReport), nextCursor });
});

const handlePost = withTiming('POST /api/v1/reports', async (request, ctx) => {
  const repos = getRepos();
  const user = await requireUser(request, repos);
  if (user instanceof Response) return user;
  const denied = requireCapability(user, CREATE_ACTION);
  if (denied) return denied;
  const parsed = await parseJson(request, CreateReportInputSchema);
  if (!parsed.ok) return parsed.response;
  const input = parsed.data;
  if (subtypeDef(input.subtype).category !== input.category) return error(400, 'bad_request', `Invalid request. subtype: ${input.subtype} is not a ${input.category} sub-type`);
  const allowed = await getRateLimiter().hit(keyFor(['reports:create', user.userId]), CREATE_LIMIT.perWindow, CREATE_LIMIT.windowSec);
  if (!allowed) return error(429, 'rate_limited', 'You have filed many reports this hour. Try again later.', { headers: { 'retry-after': String(CREATE_LIMIT.windowSec) } });
  const { row, created } = await repos.reports.create(input, { userId: user.userId, role: user.role, now: new Date().toISOString(), requestId: ctx.requestId });
  return json({ report: toPublicReport(row) }, { status: created ? 201 : 200 });
});

export async function GET(request: Request): Promise<Response> {
  return handleGet(request);
}

export async function POST(request: Request): Promise<Response> {
  return handlePost(request);
}
