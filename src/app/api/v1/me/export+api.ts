/**
 * GET /api/v1/me/export (plan §7: "GET /api/v1/me/export (2/d)"): a JSON file of everything the server links to the
 * account — profile, watch areas, own reports (public projection), votes, follows, comments, devices. Anonymous
 * reports are absent by design (plan §3.4). EXPORT_LIMIT per account through the DB-backed limiter (plan §3.10;
 * 429 with Retry-After). Needs a session.
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import { requireUser } from '@/server/auth';
import { error, json, withTiming } from '@/server/http';
import { toPublicReport } from '@/server/public';
import { getRateLimiter, keyFor } from '@/server/ratelimit';
import { getMeRepo } from '@/server/repos/me';
import { getRepos } from '@/server/repos/types';

import { buildProfile } from '../me+api';
import { MY_REPORTS_LIMIT } from './reports+api';

export const EXPORT_LIMIT = {
  perWindow: 2, // spec: plan §7 GET /api/v1/me/export 2/d
  windowSec: 86_400,
} as const;

export const EXPORT_FORMAT = 'rootcause-export/v1';

const handleGet = withTiming('GET /api/v1/me/export', async (request) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  const allowed = await getRateLimiter().hit(keyFor(['me:export', user.userId]), EXPORT_LIMIT.perWindow, EXPORT_LIMIT.windowSec);
  if (!allowed) return error(429, 'rate_limited', `You can export your data ${EXPORT_LIMIT.perWindow} times a day. Try again tomorrow.`, { headers: { 'retry-after': String(EXPORT_LIMIT.windowSec) } });
  const me = getMeRepo();
  const profile = await buildProfile(me, user.userId);
  if (!profile) return error(401, 'unauthenticated', 'This account was deleted.');
  const [rows, data] = await Promise.all([me.listOwnReports(user.userId, MY_REPORTS_LIMIT), me.exportData(user.userId)]);
  const exportedAt = new Date().toISOString();
  const { watchAreas, ...account } = profile;
  return json(
    { format: EXPORT_FORMAT, exportedAt, account, watchAreas, reports: rows.map(toPublicReport), ...data },
    { headers: { 'content-disposition': `attachment; filename="rootcause-export-${exportedAt.slice(0, 10)}.json"` } },
  );
});

export async function GET(request: Request): Promise<Response> {
  return handleGet(request);
}
