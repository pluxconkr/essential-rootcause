/**
 * POST /api/v1/me/phone (spec R14 "phone number + SMS opt-in (verified by a 6-digit code)"; plan §7 /me/phone row,
 * §3.12 D11, §23.H Twilio Verify): PhoneStartInput {phone} → Twilio Verify texts the code → the number is stored on
 * app_user as pending (phone_e164 set, phone_verified_at null, sms_opt_in false — consent never carries over to a new
 * number) → {ok: true, last4}. Needs a session and the `follow` capability (a phone exists to receive status texts for
 * followed reports; auditors get none). PHONE_START_LIMIT per account through the DB-backed limiter (429 with
 * Retry-After); Twilio's own per-number caps answer 429 too. 503 when Verify is not configured on this deploy. The
 * full number never appears in a response or a log line (plan §12).
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import type { Action } from '@/domain/roles';
import { PhoneStartInputSchema, type PhoneStartResponse } from '@/domain/types';
import { requireCapability, requireUser } from '@/server/auth';
import { error, json, parseJson, withTiming } from '@/server/http';
import { logEvent } from '@/server/log';
import { getRateLimiter, keyFor } from '@/server/ratelimit';
import { getMeRepo } from '@/server/repos/me';
import { getRepos } from '@/server/repos/types';
import { startPhoneVerification } from '@/server/sms';

export const PHONE_START_LIMIT = {
  perWindow: 5, // spec: plan §7 POST /api/v1/me/phone — per-account hourly window (5 codes an hour; Twilio caps each number on its side)
  windowSec: 3_600,
} as const;

/** A phone number serves status texts for followed reports (plan §11); residents and up, auditors refused. */
export const PHONE_ACTION: Action = 'follow';

const handlePost = withTiming('POST /api/v1/me/phone', async (request, ctx) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  const denied = requireCapability(user, PHONE_ACTION);
  if (denied) return denied;
  const parsed = await parseJson(request, PhoneStartInputSchema);
  if (!parsed.ok) return parsed.response;
  const me = getMeRepo();
  const row = await me.getMe(user.userId);
  if (!row || row.deleted_at) return error(401, 'unauthenticated', 'This account was deleted. Sign in again to start over.');
  const allowed = await getRateLimiter().hit(keyFor(['me:phone', user.userId]), PHONE_START_LIMIT.perWindow, PHONE_START_LIMIT.windowSec);
  if (!allowed) return error(429, 'rate_limited', `You can request ${PHONE_START_LIMIT.perWindow} codes an hour. Try again later.`, { headers: { 'retry-after': String(PHONE_START_LIMIT.windowSec) } });

  const phone = parsed.data.phone;
  const started = await startPhoneVerification(phone);
  if (!started.ok) {
    switch (started.reason) {
      case 'disabled':
        return error(503, 'misconfigured', 'Text-message verification is not available right now. Push and in-app alerts still work.');
      case 'limited':
        return error(429, 'rate_limited', 'That number was sent several codes already. Wait a few minutes before asking for another.', { headers: { 'retry-after': '600' } });
      case 'rejected':
        return error(400, 'bad_request', 'That number could not receive a code. Check it — US and Canadian mobile numbers only — and try again.');
      default:
        return error(500, 'internal', 'Could not reach the text-message service. Try again in a minute.');
    }
  }
  await me.startPhoneVerification(user.userId, phone);
  logEvent('info', 'me.phone_started', { requestId: ctx.requestId });
  const body: PhoneStartResponse = { ok: true, last4: phone.slice(-4) };
  return json(body);
});

export async function POST(request: Request): Promise<Response> {
  return handlePost(request);
}
