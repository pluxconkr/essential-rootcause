/**
 * POST /api/v1/me/phone/check (plan §7 "/me/phone (start) … (check)"; §23.H Twilio Verify): PhoneCheckInput {code} →
 * Twilio VerificationCheck against the pending number on app_user → approved: phone_verified_at = now and the updated
 * MeProfile (phoneVerified true, phoneLast4), so S-11 can switch texts on with PATCH /me {smsOptIn}. 400 for a wrong
 * code or no number on file, 409 when no verification is pending (codes expire after 10 minutes, and one is spent
 * once approved — send a new one), 429 when Twilio stops accepting checks. A number that is already verified answers
 * 200 with the profile, so a retry after a lost answer is not an error. Needs a session and the `follow` capability.
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import { PhoneCheckInputSchema } from '@/domain/types';
import { requireCapability, requireUser } from '@/server/auth';
import { error, json, parseJson, withTiming } from '@/server/http';
import { logEvent } from '@/server/log';
import { getMeRepo } from '@/server/repos/me';
import { getRepos } from '@/server/repos/types';
import { checkPhoneVerification } from '@/server/sms';

import { buildProfile } from '../../me+api';
import { PHONE_ACTION } from '../phone+api';

const handlePost = withTiming('POST /api/v1/me/phone/check', async (request, ctx) => {
  const user = await requireUser(request, getRepos());
  if (user instanceof Response) return user;
  const denied = requireCapability(user, PHONE_ACTION);
  if (denied) return denied;
  const parsed = await parseJson(request, PhoneCheckInputSchema);
  if (!parsed.ok) return parsed.response;
  const me = getMeRepo();
  const row = await me.getMe(user.userId);
  if (!row || row.deleted_at) return error(401, 'unauthenticated', 'This account was deleted. Sign in again to start over.');
  const phone = await me.getPhone(user.userId);
  if (!phone) return error(400, 'bad_request', 'Add a phone number first.');
  if (phone.phone_verified_at === null) {
    const checked = await checkPhoneVerification(phone.phone_e164, parsed.data.code);
    if (!checked.ok) {
      switch (checked.reason) {
        case 'disabled':
          return error(503, 'misconfigured', 'Text-message verification is not available right now.');
        case 'expired':
          return error(409, 'conflict', 'That code expired or was already used. Send a new one.');
        case 'limited':
          return error(429, 'rate_limited', 'Too many tries for this code. Send a new one.', { headers: { 'retry-after': '600' } });
        case 'rejected':
          return error(400, 'bad_request', 'That code could not be checked. Send a new one and try again.');
        default:
          return error(500, 'internal', 'Could not reach the text-message service. Try again in a minute.');
      }
    }
    if (!checked.approved) return error(400, 'bad_request', 'That code did not work. Check the digits or send a new one.');
    await me.setPhoneVerified(user.userId, new Date().toISOString());
    logEvent('info', 'me.phone_verified', { requestId: ctx.requestId });
  }
  const profile = await buildProfile(me, user.userId);
  return profile ? json(profile) : error(401, 'unauthenticated', 'This account was deleted.');
});

export async function POST(request: Request): Promise<Response> {
  return handlePost(request);
}
