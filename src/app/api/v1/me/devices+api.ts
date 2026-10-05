/**
 * POST /api/v1/me/devices (plan §7, §9.4): DeviceInput → {ok: true}. One row per Expo push token, upserted — a sign-in
 * on a shared phone moves the token to the new account (plan §6 device). Registered after the first follow, vote or
 * report; the pushReceipts job drops tokens Expo reports invalid. Needs a session and the `follow` capability (a
 * device exists to receive status pushes for followed reports; auditors receive none).
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import type { Action } from '@/domain/roles';
import { DeviceInputSchema } from '@/domain/types';
import { requireCapability, requireUser } from '@/server/auth';
import { json, parseJson, withTiming } from '@/server/http';
import { getMeRepo } from '@/server/repos/me';
import { getRepos } from '@/server/repos/types';

export const DEVICE_ACTION: Action = 'follow';

const handlePost = withTiming('POST /api/v1/me/devices', async (request) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  const denied = requireCapability(user, DEVICE_ACTION);
  if (denied) return denied;
  const parsed = await parseJson(request, DeviceInputSchema);
  if (!parsed.ok) return parsed.response;
  await getMeRepo().upsertDevice(user.userId, parsed.data, new Date().toISOString());
  return json({ ok: true });
});

export async function POST(request: Request): Promise<Response> {
  return handlePost(request);
}
