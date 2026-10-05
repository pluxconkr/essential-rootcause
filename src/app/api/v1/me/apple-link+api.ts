/**
 * POST /api/v1/me/apple-link (plan §7, §23.C): {authorizationCode} from the native Apple sheet, posted within
 * 5 minutes of sign-in → exchanged at appleid.apple.com for a refresh token → stored sealed in
 * app_user.apple_refresh_token so DELETE /me can revoke it. {ok: true} on success; 400 when Apple rejects the code
 * (expired, replayed, wrong client id); 503 without the Apple server configuration (fail closed, plan §3.10).
 * APPLE_LINK_LIMIT per account: a sign-in happens a few times an hour at most, and each call spends an Apple exchange.
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import { z } from 'zod';

import { exchangeAppleCode, sealToken } from '@/server/apple';
import { requireUser } from '@/server/auth';
import { error, json, parseJson, withTiming } from '@/server/http';
import { getRateLimiter, keyFor } from '@/server/ratelimit';
import { getMeRepo } from '@/server/repos/me';
import { getRepos } from '@/server/repos/types';

export const APPLE_LINK_LIMIT = {
  perWindow: 5,
  windowSec: 3600,
} as const;

const BodySchema = z.object({ authorizationCode: z.string().min(1).max(4096) });

const handlePost = withTiming('POST /api/v1/me/apple-link', async (request) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  const parsed = await parseJson(request, BodySchema);
  if (!parsed.ok) return parsed.response;
  const allowed = await getRateLimiter().hit(keyFor(['me:apple-link', user.userId]), APPLE_LINK_LIMIT.perWindow, APPLE_LINK_LIMIT.windowSec);
  if (!allowed) return error(429, 'rate_limited', 'Too many sign-in links this hour. Try again later.', { headers: { 'retry-after': String(APPLE_LINK_LIMIT.windowSec) } });
  const exchanged = await exchangeAppleCode(parsed.data.authorizationCode);
  if (!exchanged.ok) {
    if (exchanged.reason === 'unconfigured') return error(503, 'misconfigured', 'Sign in with Apple is not configured on this server.');
    if (exchanged.reason === 'rejected') return error(400, 'bad_request', 'Apple did not accept the authorization code. Sign in again to link your account.');
    return error(500, 'internal', 'Apple could not be reached. Try again later.');
  }
  const sealed = await sealToken(exchanged.refreshToken);
  if (!sealed) return error(503, 'misconfigured', 'Sign in with Apple is not configured on this server.');
  await getMeRepo().setAppleRefreshToken(user.userId, sealed);
  return json({ ok: true });
});

export async function POST(request: Request): Promise<Response> {
  return handlePost(request);
}
