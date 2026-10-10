/**
 * GET /api/v1/me/alerts (plan §7 /me rows; spec R8 "Alerts inbox"): {alerts: MyAlert[]} — the account's alert
 * deliveries, one per alert whatever the channels, newest first, each with the AlertBody the scenario job wrote
 * (src/domain/types.ts MyAlertListSchema). Fetching is the inbox delivery: queued inbox rows become delivered here
 * (plan §11 channel policy "inbox yes"). Needs a session and the `follow` capability — alerts exist for residents
 * and followers; auditors receive none (plan §12). Expo Router API route: no React Native imports; handlers return
 * a Response and never throw (withTiming).
 */
import type { Action } from '@/domain/roles';
import { AlertBodySchema, type MyAlert } from '@/domain/types';
import { requireCapability, requireUser } from '@/server/auth';
import { json, withTiming } from '@/server/http';
import { logEvent } from '@/server/log';
import { getAlertsRepo, type MyAlertRow } from '@/server/repos/alerts';
import { getRepos } from '@/server/repos/types';

export const MY_ALERTS_LIMIT = 50; // plenty for one resident at two predictive alerts a week (spec §9)
export const ALERTS_ACTION: Action = 'follow';

/** The row as the phone sees it; a body that no longer parses is dropped and logged rather than failing the inbox. */
export function toMyAlert(row: MyAlertRow): MyAlert | null {
  const body = AlertBodySchema.safeParse(row.body);
  if (!body.success) {
    logEvent('warn', 'alerts.body_invalid', { alertId: row.alert_id });
    return null;
  }
  return { id: row.alert_id, at: row.created_at, read: row.opened_at !== null, body: body.data };
}

const handleGet = withTiming('GET /api/v1/me/alerts', async (request) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  const denied = requireCapability(user, ALERTS_ACTION);
  if (denied) return denied;
  const repo = getAlertsRepo();
  const rows = await repo.listForUser(user.userId, MY_ALERTS_LIMIT);
  const alerts = rows.map(toMyAlert).filter((a): a is MyAlert => a !== null);
  if (alerts.length > 0) await repo.markInboxDelivered(user.userId, alerts.map((a) => a.id), new Date().toISOString());
  return json({ alerts });
});

export async function GET(request: Request): Promise<Response> {
  return handleGet(request);
}
