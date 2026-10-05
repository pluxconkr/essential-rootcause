/**
 * /api/v1/me (plan §7: "profile, quiet hours, sms opt-in, impact stats; DELETE = de-identify + delete auth user")
 *   GET    → MeProfile: role (app_user, not the token — plan §3.4), display name, email, provider, phone/SMS state,
 *            quiet hours, impact stats and watch areas. 401 without a session or for a deleted account's tombstone.
 *   PATCH  MePatch → the updated MeProfile. smsOptIn can only be switched on once a phone number is verified (M2).
 *   DELETE → 204 after the plan §23.C order: revoke the Apple refresh token (best effort, logged) → de-identify in
 *            one transaction → auth.admin.deleteUser. 500 when the auth user could not be deleted (the client retries;
 *            de-identification is idempotent). Reports, photos and events stay as public records (plan §12).
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import { MePatchSchema, type MeProfile } from '@/domain/types';
import { openToken, revokeApple } from '@/server/apple';
import { requireUser } from '@/server/auth';
import { error, json, parseJson, withTiming } from '@/server/http';
import { logEvent } from '@/server/log';
import { getMeRepo, type MeRepo } from '@/server/repos/me';
import { getRepos } from '@/server/repos/types';

/** The profile the phone caches; null for an unknown id or a de-identified tombstone. */
export async function buildProfile(me: MeRepo, userId: string): Promise<MeProfile | null> {
  const row = await me.getMe(userId);
  if (!row || row.deleted_at) return null;
  const [stats, watchAreas] = await Promise.all([me.getStats(userId), me.listWatchAreas(userId)]);
  return {
    userId: row.id,
    role: row.role,
    displayName: row.display_name,
    email: row.email,
    provider: row.auth_provider,
    phoneVerified: row.phone_verified_at !== null,
    smsOptIn: row.sms_opt_in,
    quietHours: row.quiet_hours,
    stats,
    watchAreas,
    createdAt: row.created_at,
  };
}

const deletedAccount = () => error(401, 'unauthenticated', 'This account was deleted. Sign in again to start over.');

const handleGet = withTiming('GET /api/v1/me', async (request) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  const profile = await buildProfile(getMeRepo(), user.userId);
  return profile ? json(profile) : deletedAccount();
});

const handlePatch = withTiming('PATCH /api/v1/me', async (request) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  const parsed = await parseJson(request, MePatchSchema);
  if (!parsed.ok) return parsed.response;
  const patch = parsed.data;
  if (patch.displayName === undefined && patch.quietHours === undefined && patch.smsOptIn === undefined) return error(400, 'bad_request', 'Invalid request. body: nothing to change (displayName, quietHours or smsOptIn).');
  const me = getMeRepo();
  const row = await me.getMe(user.userId);
  if (!row || row.deleted_at) return deletedAccount();
  if (patch.smsOptIn === true && row.phone_verified_at === null) return error(400, 'bad_request', 'Invalid request. smsOptIn: verify a phone number first.');
  await me.patchMe(user.userId, patch);
  const profile = await buildProfile(me, user.userId);
  return profile ? json(profile) : deletedAccount();
});

const handleDelete = withTiming('DELETE /api/v1/me', async (request, ctx) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  const me = getMeRepo();
  const row = await me.getMe(user.userId);
  if (!row) return error(404, 'not_found', 'No such account.');
  // 1. Apple requires revocation when an account that used Sign in with Apple is deleted (plan §23.C). Best effort.
  if (row.apple_refresh_token) {
    const plain = await openToken(row.apple_refresh_token);
    const revoked = plain ? await revokeApple(plain) : false;
    logEvent(revoked ? 'info' : 'warn', 'me.apple_revoke', { requestId: ctx.requestId, revoked, sealed: plain !== null });
  }
  // 2. De-identify in one transaction; a failure here throws → 500 and nothing below runs.
  const counts = await me.deidentify(user.userId, new Date().toISOString());
  logEvent('info', 'me.deidentified', { requestId: ctx.requestId, ...counts });
  // 3. Only now the sign-in account itself.
  const deleted = await me.deleteAuthUser(user.userId);
  if (!deleted) return error(500, 'internal', 'Your data was removed, but the sign-in account could not be deleted yet. Try again in a minute.');
  return new Response(null, { status: 204 });
});

export async function GET(request: Request): Promise<Response> {
  return handleGet(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handlePatch(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handleDelete(request);
}
