/**
 * Twilio for the API routes and the status-change notifier (owner decision D11 "Twilio with one +1 number inside a
 * Messaging Service"; plan §3.12, §7 /me/phone rows, §11 channel policy, §23.H). Three calls, all plain `fetch` with
 * Basic auth against the Twilio REST API — never the twilio npm package, which does not run on EAS Hosting's workerd
 * (plan §3.10 "Twilio via its REST API with basic auth"):
 *   - startPhoneVerification / checkPhoneVerification → Twilio Verify v2 (exempt from 10DLC, so S-11 works before the
 *     campaign is approved). Twilio sends and checks the 6-digit code itself, so there is no OTP table (§23.H) and no
 *     sms_message row: Verify's SMS leaves Twilio's pool, not our number.
 *   - sendSms → Messages API with MessagingServiceSid (the service owns the number and answers STOP/HELP) plus the
 *     status-callback URL. The sms_message claim row is written BEFORE the call, under a claim id, and rewritten to the
 *     Message SID once Twilio answers (§23.H "the row is the claim"), so a retried tick never sends twice.
 * Fail closed: SMS_ENABLED=false or missing credentials → {ok: false, reason: 'disabled'} and no network call; a number
 * outside SMS_ALLOWLIST (while the list is set) and a tenant with sms_enabled = false (the runbook's pause; plan §23.I
 * "a send requires both") are refused the same way before the claim row. Verify needs only its own credentials
 * because the kill switch guards our registered number (§3.12 "blocked, not filtered"). Nothing here throws. Log
 * lines carry at most the last four digits (src/server/log.ts masks `phone*` fields regardless). The fetch is
 * injectable for tests (setTwilioFetch). Server-only module.
 */
import { getServerEnv, isConfigured, type ServerEnv } from './env';
import { logEvent } from './log';
import { getSmsRepo, type DeliveryStatus, type SmsKind, type SmsRepo } from './repos/sms';

export const TWILIO = {
  apiBase: 'https://api.twilio.com/2010-04-01', // spec: Twilio Messages REST API (plan §3.12)
  verifyBase: 'https://verify.twilio.com/v2', // spec: Twilio Verify v2 (plan §23.H "phone verification uses Twilio Verify")
  timeoutMs: 10_000, // one call fits inside a route's request budget (R1) and the jobs tick (plan §23.G)
  unsubscribedErrorCode: '21610', // spec: Twilio error 21610 "attempt to send to unsubscribed recipient" — STOP mirrored to sms_opt_in (plan §12)
} as const;

export const SMS_SEGMENT = 160; // spec: plan §11 "each SMS is one segment where possible (≤ 160 GSM-7 characters)"

export type VerifyFailure = 'disabled' | 'limited' | 'expired' | 'rejected' | 'network';
export type VerifyStartResult = { ok: true; sid: string } | { ok: false; reason: Exclude<VerifyFailure, 'expired'>; code: number | null };
export type VerifyCheckResult = { ok: true; approved: boolean } | { ok: false; reason: VerifyFailure; code: number | null };

export interface SmsRequest {
  /** E.164. */
  to: string;
  body: string;
  kind: SmsKind;
  userId: string | null;
  alertId: string | null;
  tenantId: string;
}

export type SmsResult = { ok: true; sid: string; status: DeliveryStatus } | { ok: false; reason: 'disabled' | 'duplicate' | 'rejected' | 'failed'; errorCode: string | null };

export type TwilioFetch = (url: string, init: RequestInit) => Promise<Response>;

let fetchOverride: TwilioFetch | null = null;

/** Tests inject a fake Twilio; null restores the global fetch. */
export function setTwilioFetch(f: TwilioFetch | null): void {
  fetchOverride = f;
}

interface TwilioCreds {
  accountSid: string;
  authToken: string;
}

/** The server env with both Twilio credentials, or null (unconfigured deploy, or the Supabase env missing → nothing is called). */
function twilioEnv(): { env: ServerEnv; auth: TwilioCreds } | null {
  if (!isConfigured()) return null;
  const env = getServerEnv();
  if (!env.twilioAccountSid || !env.twilioAuthToken) return null;
  return { env, auth: { accountSid: env.twilioAccountSid, authToken: env.twilioAuthToken } };
}

interface TwilioAnswer {
  status: number;
  body: Record<string, unknown>;
}

/** One form-encoded POST with Basic auth; a non-JSON answer leaves `body` empty so the status alone decides. */
async function twilioPost(url: string, form: Record<string, string>, auth: TwilioCreds): Promise<TwilioAnswer> {
  const doFetch = fetchOverride ?? ((u: string, init: RequestInit) => fetch(u, init));
  const res = await doFetch(url, {
    method: 'POST',
    headers: { authorization: `Basic ${btoa(`${auth.accountSid}:${auth.authToken}`)}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TWILIO.timeoutMs),
  });
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    /* no JSON body */
  }
  return { status: res.status, body };
}

const codeOf = (body: Record<string, unknown>): number | null => (typeof body.code === 'number' ? body.code : null);
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

// ---------- Twilio Verify (phone number verification) ----------

/** Asks Twilio Verify to text a code to the number. */
export async function startPhoneVerification(phoneE164: string): Promise<VerifyStartResult> {
  const t = twilioEnv();
  if (!t || !t.env.twilioVerifyServiceSid) return { ok: false, reason: 'disabled', code: null };
  try {
    const { status, body } = await twilioPost(`${TWILIO.verifyBase}/Services/${t.env.twilioVerifyServiceSid}/Verifications`, { To: phoneE164, Channel: 'sms' }, t.auth);
    if ((status === 201 || status === 200) && typeof body.sid === 'string') return { ok: true, sid: body.sid };
    const code = codeOf(body);
    logEvent('warn', 'sms.verify_start_failed', { status, code });
    if (status === 429 || code === 60203) return { ok: false, reason: 'limited', code }; // spec: Twilio 60203 "max send attempts reached"
    if (status >= 400 && status < 500) return { ok: false, reason: 'rejected', code };
    return { ok: false, reason: 'network', code };
  } catch (e) {
    logEvent('warn', 'sms.verify_start_failed', { error: asError(e) });
    return { ok: false, reason: 'network', code: null };
  }
}

/** Checks the code the resident typed against the pending verification for the number. */
export async function checkPhoneVerification(phoneE164: string, code: string): Promise<VerifyCheckResult> {
  const t = twilioEnv();
  if (!t || !t.env.twilioVerifyServiceSid) return { ok: false, reason: 'disabled', code: null };
  try {
    const { status, body } = await twilioPost(`${TWILIO.verifyBase}/Services/${t.env.twilioVerifyServiceSid}/VerificationCheck`, { To: phoneE164, Code: code }, t.auth);
    if (status === 200) return { ok: true, approved: body.status === 'approved' };
    const twilioCode = codeOf(body);
    logEvent('warn', 'sms.verify_check_failed', { status, code: twilioCode });
    if (status === 404 || twilioCode === 20404) return { ok: false, reason: 'expired', code: twilioCode }; // spec: Twilio 20404 — no pending verification (expired after 10 min or already used)
    if (status === 429 || twilioCode === 60202) return { ok: false, reason: 'limited', code: twilioCode }; // spec: Twilio 60202 "max check attempts reached"
    if (status >= 400 && status < 500) return { ok: false, reason: 'rejected', code: twilioCode };
    return { ok: false, reason: 'network', code: twilioCode };
  } catch (e) {
    logEvent('warn', 'sms.verify_check_failed', { error: asError(e) });
    return { ok: false, reason: 'network', code: null };
  }
}

// ---------- Messages ----------

/** Twilio's MessageStatus → delivery_status. accepted/scheduled/queued/sending (and anything new) stay 'queued'. */
export function deliveryStatusOf(twilioStatus: unknown): DeliveryStatus {
  switch (String(twilioStatus ?? '').toLowerCase()) {
    case 'sent':
      return 'sent';
    case 'delivered':
    case 'read':
      return 'delivered';
    case 'undelivered':
      return 'undelivered';
    case 'failed':
    case 'canceled':
      return 'failed';
    default:
      return 'queued';
  }
}

/**
 * Sends one text through the Messaging Service. Claim design: sms_message.sid is the primary key and Twilio's Message
 * SID is only known after the call, so the claim row is inserted first under `claim_<uuid>` (status 'queued') and its
 * sid is rewritten to the Message SID on success (nothing references sms_message, so the key change is one UPDATE);
 * on failure the row keeps the claim id with status 'failed' and the Twilio error code. A duplicate (alert_id,
 * user_id) claim — a retried tick — is refused by the partial unique index and no request leaves.
 */
export async function sendSms(req: SmsRequest, opts: { now?: string } = {}): Promise<SmsResult> {
  const t = twilioEnv();
  if (!t || !t.env.smsEnabled || !t.env.twilioMessagingServiceSid) return { ok: false, reason: 'disabled', errorCode: null };
  const last4 = req.to.slice(-4);
  // SMS_ALLOWLIST (preview testers): while the list is set, every other number is refused before any row or request.
  if (t.env.smsAllowlist.length > 0 && !t.env.smsAllowlist.includes(req.to)) {
    logEvent('info', 'sms.not_allowlisted', { kind: req.kind, toLast4: last4 });
    return { ok: false, reason: 'disabled', errorCode: null };
  }
  const now = opts.now ?? new Date().toISOString();
  const claimSid = `claim_${crypto.randomUUID()}`;
  let repo: SmsRepo;
  try {
    repo = getSmsRepo();
    // tenant.sms_enabled is the runtime switch the runbook flips (SMS_ENABLED && tenant.sms_enabled, plan §23.I): a paused tenant writes no claim row.
    if (!(await repo.tenantSmsEnabled(req.tenantId))) {
      logEvent('info', 'sms.tenant_disabled', { kind: req.kind, tenantId: req.tenantId });
      return { ok: false, reason: 'disabled', errorCode: null };
    }
    const claimed = await repo.claim({ sid: claimSid, tenant_id: req.tenantId, kind: req.kind, user_id: req.userId, alert_id: req.alertId, to_last4: last4, now });
    if (!claimed) return { ok: false, reason: 'duplicate', errorCode: null };
  } catch (e) {
    logEvent('warn', 'sms.claim_failed', { kind: req.kind, error: asError(e) });
    return { ok: false, reason: 'failed', errorCode: null };
  }
  const form: Record<string, string> = { MessagingServiceSid: t.env.twilioMessagingServiceSid, To: req.to, Body: req.body };
  if (t.env.twilioWebhookUrl) form.StatusCallback = t.env.twilioWebhookUrl;
  try {
    const { status, body } = await twilioPost(`${TWILIO.apiBase}/Accounts/${t.auth.accountSid}/Messages.json`, form, t.auth);
    if ((status === 201 || status === 200) && typeof body.sid === 'string') {
      const delivery = deliveryStatusOf(body.status);
      await repo.confirm(claimSid, body.sid, delivery, now);
      logEvent('info', 'sms.sent', { kind: req.kind, status: delivery, toLast4: last4 });
      return { ok: true, sid: body.sid, status: delivery };
    }
    const errorCode = body.code !== undefined && body.code !== null ? String(body.code) : String(status);
    await repo.fail(claimSid, errorCode, now);
    logEvent('warn', 'sms.send_failed', { kind: req.kind, status, errorCode, toLast4: last4 });
    return { ok: false, reason: status >= 400 && status < 500 ? 'rejected' : 'failed', errorCode };
  } catch (e) {
    logEvent('warn', 'sms.send_failed', { kind: req.kind, toLast4: last4, error: asError(e) });
    try {
      await repo.fail(claimSid, null, now);
    } catch {
      /* the claim row stays 'queued'; the log line above is the record */
    }
    return { ok: false, reason: 'failed', errorCode: null };
  }
}

// ---------- Copy ----------

/** Typographic punctuation → its GSM-7 twin, so the default copy stays inside one segment instead of switching to UCS-2 (70 chars). */
export function gsm7(text: string): string {
  return text.replace(/[—–]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/·/g, '-');
}

/** `${head} ${tail}` inside one segment: the tail (the STOP line) always survives, the head is cut at a word boundary. */
export function fitSms(head: string, tail: string): string {
  const h = gsm7(head).trim();
  const t = gsm7(tail).trim();
  const room = SMS_SEGMENT - t.length - 1;
  if (h.length <= room) return `${h} ${t}`;
  const cut = h.slice(0, room - 3);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > room / 2 ? cut.slice(0, atWord) : cut).trimEnd()}... ${t}`;
}

// ---------- Status callback signature ----------

/** Twilio's request signature: Base64(HMAC-SHA1(auth token, url + Σ key+value over the POST params sorted by key)). */
export async function twilioSignature(url: string, params: Record<string, string>, authToken: string): Promise<string> {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  return btoa(String.fromCharCode(...mac));
}

/** The X-Twilio-Signature header against the configured webhook URL (plan §23.H: the env value verbatim, never request.url); constant time, false without a header. */
export async function verifyTwilioSignature(given: string | null, url: string, params: Record<string, string>, authToken: string): Promise<boolean> {
  if (!given) return false;
  const expected = await twilioSignature(url, params, authToken);
  const enc = new TextEncoder();
  // Both sides hashed to a fixed length first, so neither the length nor the position of a mismatch leaks.
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(expected))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
