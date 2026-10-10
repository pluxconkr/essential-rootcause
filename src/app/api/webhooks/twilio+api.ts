/**
 * POST /api/webhooks/twilio (plan §7 route table "Twilio signature → delivery status → alert_delivery"; §3.12; §12
 * "Twilio webhook signature validated; STOP … mirrored to sms_opt_in = false"; §23.H webhook contract): Twilio's
 * status callback for every message sent through the Messaging Service. The body is form-encoded; the
 * X-Twilio-Signature header is HMAC-SHA1 over TWILIO_WEBHOOK_URL (the env value verbatim — never request.url, which a
 * proxy may rewrite) plus the sorted parameters, checked in constant time with WebCrypto. A valid callback moves the
 * sms_message row (by Message SID) and any alert_delivery row (by provider_id) forward — queued < sent < delivered,
 * failed/undelivered terminal, regressions ignored — and a 21610 (recipient replied STOP) switches that account's
 * sms_opt_in off. 403 for a bad or missing signature, 503 when the auth token or the URL is not configured, 204 for
 * every valid callback, including one for a SID this server never wrote (Twilio retries on anything else).
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import { getServerEnv } from '@/server/env';
import { error, withTiming } from '@/server/http';
import { logEvent } from '@/server/log';
import { getMeRepo } from '@/server/repos/me';
import { getSmsRepo } from '@/server/repos/sms';
import { TWILIO, deliveryStatusOf, verifyTwilioSignature } from '@/server/sms';

export const TWILIO_SIGNATURE_HEADER = 'x-twilio-signature'; // spec: Twilio "Validating requests" — X-Twilio-Signature on every callback

/** request.formData() is typed by React Native's globals in this project (no entries()); the runtime (workerd / Node) is the standard one. */
type UrlEncodedForm = Iterable<[string, unknown]>;

/** The callback's form fields as a plain record (Twilio sends strings only; a file part would be ignored). */
async function formParams(request: Request): Promise<Record<string, string> | null> {
  try {
    const form = (await request.formData()) as unknown as UrlEncodedForm;
    const out: Record<string, string> = {};
    for (const [key, value] of form) if (typeof value === 'string') out[key] = value;
    return out;
  } catch {
    return null;
  }
}

const handlePost = withTiming('POST /api/webhooks/twilio', async (request, ctx) => {
  const env = getServerEnv();
  if (!env.twilioAuthToken || !env.twilioWebhookUrl) return error(503, 'misconfigured', 'The Twilio webhook is not configured on this deploy.');
  const params = await formParams(request);
  if (!params) return error(400, 'bad_request', 'Body must be form-encoded.');
  const valid = await verifyTwilioSignature(request.headers.get(TWILIO_SIGNATURE_HEADER), env.twilioWebhookUrl, params, env.twilioAuthToken);
  if (!valid) {
    logEvent('warn', 'sms.webhook_rejected', { requestId: ctx.requestId });
    return error(403, 'forbidden', 'Invalid Twilio signature.');
  }
  const sid = params.MessageSid ?? params.SmsSid ?? '';
  const status = deliveryStatusOf(params.MessageStatus ?? params.SmsStatus);
  const errorCode = params.ErrorCode?.trim() || null;
  let known = false;
  let deliveries = 0;
  if (sid) {
    const now = new Date().toISOString();
    const repo = getSmsRepo();
    const row = await repo.updateStatus(sid, status, errorCode, now);
    known = row !== null;
    deliveries = await repo.updateDeliveryByProviderId(sid, status, errorCode, now);
    // The Messaging Service honours STOP itself; the account's consent flag follows so no later send is even attempted (plan §12).
    if (errorCode === TWILIO.unsubscribedErrorCode && row?.user_id) await getMeRepo().patchMe(row.user_id, { smsOptIn: false });
  }
  logEvent('info', 'sms.status', { requestId: ctx.requestId, status, errorCode, known, deliveries });
  return new Response(null, { status: 204 });
});

export async function POST(request: Request): Promise<Response> {
  return handlePost(request);
}
