/**
 * POST /api/v1/me/alerts/[id]/read (plan §7 /me rows; spec R8/R9): the read receipt — sets opened_at on every
 * delivery of the alert for this account. Idempotent: 200 {alertId, read: true} the first time and on a replay
 * (the phone posts it best-effort after a reconnect); 404 when the account has no delivery of that alert. Needs a
 * session and the `follow` capability, like GET /me/alerts. Expo Router API route: no React Native imports;
 * handlers return a Response and never throw (withTiming).
 */
import type { Action } from '@/domain/roles';
import { requireCapability, requireUser } from '@/server/auth';
import { error, json, withTiming } from '@/server/http';
import { getAlertsRepo } from '@/server/repos/alerts';
import { getRepos } from '@/server/repos/types';

export const READ_ACTION: Action = 'follow';

const handlePost = withTiming('POST /api/v1/me/alerts/[id]/read', async (request, { params }) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  const denied = requireCapability(user, READ_ACTION);
  if (denied) return denied;
  const id = params.id?.trim() ?? '';
  const found = id ? await getAlertsRepo().markOpened(user.userId, id, new Date().toISOString()) : false;
  if (!found) return error(404, 'not_found', 'No such alert.');
  return json({ alertId: id, read: true });
});

export async function POST(request: Request, params: Record<string, string> = {}): Promise<Response> {
  return handlePost(request, params);
}
