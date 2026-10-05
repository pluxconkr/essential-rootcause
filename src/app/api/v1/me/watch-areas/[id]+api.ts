/**
 * /api/v1/me/watch-areas/[id] (plan §7 /me rows)
 *   PATCH  partial WatchAreaInput → {watchArea}; 404 when the area is not this account's.
 *   DELETE → 204; 404 when the area is not this account's.
 * Same gate as the collection route: session + `follow` capability.
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import { WatchAreaInputSchema } from '@/domain/types';
import { requireCapability, requireUser } from '@/server/auth';
import { error, json, parseJson, withTiming } from '@/server/http';
import { getMeRepo } from '@/server/repos/me';
import { getRepos } from '@/server/repos/types';

import { WATCH_ACTION } from '../watch-areas+api';

const PatchSchema = WatchAreaInputSchema.partial();

const notFound = () => error(404, 'not_found', 'No such watch area.');

const handlePatch = withTiming('PATCH /api/v1/me/watch-areas/[id]', async (request, { params }) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  const denied = requireCapability(user, WATCH_ACTION);
  if (denied) return denied;
  const id = params.id?.trim() ?? '';
  if (!id) return notFound();
  const parsed = await parseJson(request, PatchSchema);
  if (!parsed.ok) return parsed.response;
  if (Object.values(parsed.data).every((v) => v === undefined)) return error(400, 'bad_request', 'Invalid request. body: nothing to change.');
  const watchArea = await getMeRepo().updateWatchArea(user.userId, id, parsed.data);
  return watchArea ? json({ watchArea }) : notFound();
});

const handleDelete = withTiming('DELETE /api/v1/me/watch-areas/[id]', async (request, { params }) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  const denied = requireCapability(user, WATCH_ACTION);
  if (denied) return denied;
  const id = params.id?.trim() ?? '';
  const removed = id ? await getMeRepo().deleteWatchArea(user.userId, id) : false;
  return removed ? new Response(null, { status: 204 }) : notFound();
});

export async function PATCH(request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handlePatch(request, params);
}

export async function DELETE(request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handleDelete(request, params);
}
