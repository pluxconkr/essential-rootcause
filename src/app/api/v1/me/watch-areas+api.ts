/**
 * /api/v1/me/watch-areas (plan §7 /me rows; spec R14 watch areas CRUD)
 *   GET  → {watchAreas: WatchArea[]} — the account's own areas only; watch areas are never exposed to anyone else (plan §6, §12).
 *   POST WatchAreaInput → 201 {watchArea}. At most WATCH_AREA_MAX per account.
 * Needs a session (D3) and the `follow` capability: alerts for a watch area are a resident's civic action, and the
 * auditor role has none (plan §12 "auditor writes rejected everywhere").
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import type { Action } from '@/domain/roles';
import { WatchAreaInputSchema } from '@/domain/types';
import { requireCapability, requireUser } from '@/server/auth';
import { error, json, parseJson, withTiming } from '@/server/http';
import { getMeRepo } from '@/server/repos/me';
import { getRepos } from '@/server/repos/types';

export const WATCH_AREA_MAX = 10; // home, work, a few routes and custom spots; every area joins the audience RPC per hazard (plan §6 audience_for_hazards)

export const WATCH_ACTION: Action = 'follow';

const handleGet = withTiming('GET /api/v1/me/watch-areas', async (request) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  return json({ watchAreas: await getMeRepo().listWatchAreas(user.userId) });
});

const handlePost = withTiming('POST /api/v1/me/watch-areas', async (request) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  const denied = requireCapability(user, WATCH_ACTION);
  if (denied) return denied;
  const parsed = await parseJson(request, WatchAreaInputSchema);
  if (!parsed.ok) return parsed.response;
  const me = getMeRepo();
  const existing = await me.listWatchAreas(user.userId);
  if (existing.length >= WATCH_AREA_MAX) return error(400, 'bad_request', `You can keep up to ${WATCH_AREA_MAX} watch areas. Remove one first.`);
  const watchArea = await me.createWatchArea(user.userId, parsed.data);
  return json({ watchArea }, { status: 201 });
});

export async function GET(request: Request): Promise<Response> {
  return handleGet(request);
}

export async function POST(request: Request): Promise<Response> {
  return handlePost(request);
}
