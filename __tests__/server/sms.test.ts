/**
 * server/sms.ts, the Twilio status webhook and the status-change SMS leg (plan §3.12 D11, §11 channel policy, §12,
 * §23.H; AC21): sendSms is fail-closed — SMS_ENABLED=false or missing credentials → {reason: 'disabled'}, no fetch,
 * no row · a number outside SMS_ALLOWLIST and a tenant with sms_enabled = false are refused the same way before the
 * claim row · getSmsRepo() reads the dev-memory bundle's repo ahead of Supabase, the test override ahead of both ·
 * with SMS on, the sms_message claim row exists (status queued, claim id) before Twilio is called and is
 * rewritten to the Message SID after, and the form carries MessagingServiceSid, To, Body and the StatusCallback URL ·
 * a duplicate (alert, user) claim never sends · a Twilio refusal marks the row failed with the error code · fitSms
 * keeps the STOP line inside one GSM-7 segment · the webhook validates X-Twilio-Signature against the configured URL
 * (Twilio's documented vector), advances sms_message and alert_delivery rows (regressions ignored), mirrors STOP
 * (21610) to sms_opt_in = false, answers 204 for an unknown SID, 403 for a forged or missing signature and 503
 * unconfigured · notifyStatusChange texts verified, opted-in accounts without a device and nobody else.
 */
import { createHmac } from 'crypto';

import { POST as WEBHOOK, TWILIO_SIGNATURE_HEADER } from '@/app/api/webhooks/twilio+api';
import type { CreateReportInput } from '@/domain/types';
import { setLogSink } from '@/server/log';
import { notifyStatusChange, statusChangeSms } from '@/server/notify';
import { setPushSender } from '@/server/push';
import { setEngagementRepo } from '@/server/repos/engagement';
import { setMeRepo } from '@/server/repos/me';
import { createMemoryRepos, type MemoryRepos } from '@/server/repos/memory';
import { MemoryEngagementRepo } from '@/server/repos/memory/engagement';
import { MemoryMeRepo } from '@/server/repos/memory/me';
import { MemorySmsRepo } from '@/server/repos/memory/smsStatus';
import { advances, getSmsRepo, setSmsRepo } from '@/server/repos/sms';
import { SMS_SEGMENT, TWILIO, deliveryStatusOf, fitSms, gsm7, sendSms, setTwilioFetch, twilioSignature } from '@/server/sms';
import { setRepos, type ReportRow } from '@/server/repos/types';

const WEBHOOK_URL = 'https://rootcause.example.org/api/webhooks/twilio';
const ENV = { SUPABASE_URL: 'https://test-project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-for-tests', TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'twilio-token', TWILIO_MESSAGING_SERVICE_SID: 'MGtest', TWILIO_WEBHOOK_URL: WEBHOOK_URL };
const NOW = '2026-10-05T12:00:00.000Z';
const NUMBER = '+17325550100';
/** New York wall-clock instants (EST = UTC−5), as in engagement-notify.test.ts. */
const est = (h: number) => Date.parse(`2026-01-16T${String((h + 5) % 24).padStart(2, '0')}:00:00Z`);

interface TwilioCall {
  url: string;
  headers: Record<string, string>;
  form: URLSearchParams;
  /** sms_message rows as they were when Twilio was called. */
  rowsAtCall: { sid: string; status: string }[];
}

let repos: MemoryRepos;
let me: MemoryMeRepo;
let sms: MemorySmsRepo;
let calls: TwilioCall[];
let reply: () => Response;
let restoreEnv: () => void;

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function withEnv(vars: Record<string, string>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

const request = (kind: 'status' | 'alert' = 'status', over: Partial<Parameters<typeof sendSms>[0]> = {}) => ({ to: NUMBER, body: 'RootCause: 12 Somerset St: Fixed - please verify. Reply STOP to opt out.', kind, userId: 'u_jane', alertId: null, tenantId: 'pilot', ...over });

async function signedCallback(params: Record<string, string>, opts: { signature?: string | null; contentType?: string } = {}): Promise<Response> {
  const signature = opts.signature === undefined ? await twilioSignature(WEBHOOK_URL, params, ENV.TWILIO_AUTH_TOKEN) : opts.signature;
  const headers: Record<string, string> = { 'content-type': opts.contentType ?? 'application/x-www-form-urlencoded' };
  if (signature !== null) headers[TWILIO_SIGNATURE_HEADER] = signature;
  return WEBHOOK(new Request(WEBHOOK_URL, { method: 'POST', headers, body: new URLSearchParams(params).toString() }));
}

beforeAll(() => setLogSink(() => {}));
afterAll(() => {
  setLogSink(null);
  setSmsRepo(null);
  setMeRepo(null);
  setEngagementRepo(null);
  setPushSender(null);
  setTwilioFetch(null);
});

beforeEach(() => {
  restoreEnv = withEnv({ ...ENV, SMS_ENABLED: 'true', SMS_ALLOWLIST: '' });
  repos = createMemoryRepos();
  repos.users.seed({ id: 'u_jane', display_name: 'Jane Doe' });
  me = new MemoryMeRepo(repos);
  sms = new MemorySmsRepo();
  setMeRepo(me);
  setSmsRepo(sms);
  calls = [];
  reply = () => jsonResponse(201, { sid: 'SM0001', status: 'queued', error_code: null });
  setTwilioFetch(async (url, init) => {
    calls.push({ url, headers: init.headers as Record<string, string>, form: new URLSearchParams(String(init.body)), rowsAtCall: sms.messages.map((m) => ({ sid: m.sid, status: m.status })) });
    return reply();
  });
});

afterEach(() => restoreEnv());

describe('sendSms', () => {
  test('fails closed: SMS_ENABLED off, or a missing credential → disabled, no request, no row', async () => {
    process.env.SMS_ENABLED = 'false';
    expect(await sendSms(request())).toEqual({ ok: false, reason: 'disabled', errorCode: null });
    process.env.SMS_ENABLED = 'true';
    delete process.env.TWILIO_MESSAGING_SERVICE_SID;
    expect(await sendSms(request())).toEqual({ ok: false, reason: 'disabled', errorCode: null });
    process.env.TWILIO_MESSAGING_SERVICE_SID = 'MGtest';
    delete process.env.TWILIO_AUTH_TOKEN;
    expect(await sendSms(request())).toEqual({ ok: false, reason: 'disabled', errorCode: null });
    delete process.env.SUPABASE_URL;
    process.env.TWILIO_AUTH_TOKEN = 'twilio-token';
    expect(await sendSms(request())).toEqual({ ok: false, reason: 'disabled', errorCode: null });
    expect(calls).toEqual([]);
    expect(sms.messages).toEqual([]);
  });

  test('the claim row is written before Twilio is called and becomes the Message SID after; the form carries the service, number, body and callback', async () => {
    const res = await sendSms(request('status'), { now: NOW });
    expect(res).toEqual({ ok: true, sid: 'SM0001', status: 'queued' });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe(`${TWILIO.apiBase}/Accounts/ACtest/Messages.json`);
    expect(call.headers.authorization).toBe(`Basic ${btoa('ACtest:twilio-token')}`);
    expect(call.form.get('MessagingServiceSid')).toBe('MGtest');
    expect(call.form.get('To')).toBe(NUMBER);
    expect(call.form.get('Body')).toMatch(/^RootCause: 12 Somerset St/);
    expect(call.form.get('StatusCallback')).toBe(WEBHOOK_URL);
    expect(call.rowsAtCall).toHaveLength(1);
    expect(call.rowsAtCall[0].sid).toMatch(/^claim_[0-9a-f-]{36}$/);
    expect(call.rowsAtCall[0].status).toBe('queued');
    expect(sms.messages).toHaveLength(1);
    expect(sms.messages[0]).toMatchObject({ sid: 'SM0001', tenant_id: 'pilot', kind: 'status', user_id: 'u_jane', alert_id: null, to_last4: '0100', status: 'queued', error_code: null, created_at: NOW, updated_at: NOW });
    expect(JSON.stringify(sms.messages)).not.toMatch(/17325550100/);
  });

  test('a second claim for the same alert and account never sends; a refusal marks the row failed with the code; a dead Twilio is reported, not thrown', async () => {
    expect((await sendSms(request('alert', { alertId: 'al_1' }))).ok).toBe(true);
    reply = () => jsonResponse(201, { sid: 'SM0002', status: 'accepted' });
    expect(await sendSms(request('alert', { alertId: 'al_1' }))).toEqual({ ok: false, reason: 'duplicate', errorCode: null });
    expect(calls).toHaveLength(1);
    expect(sms.messages).toHaveLength(1);

    reply = () => jsonResponse(400, { code: 21211, message: "The 'To' number is not a valid phone number.", status: 400 });
    expect(await sendSms(request('status', { to: '+15005550001' }))).toEqual({ ok: false, reason: 'rejected', errorCode: '21211' });
    expect(sms.messages[1]).toMatchObject({ status: 'failed', error_code: '21211', to_last4: '0001' });
    expect(sms.messages[1].sid).toMatch(/^claim_/);

    reply = () => new Response('<html>502</html>', { status: 502 });
    expect(await sendSms(request())).toEqual({ ok: false, reason: 'failed', errorCode: '502' });
    setTwilioFetch(async () => {
      throw new Error('twilio down');
    });
    expect(await sendSms(request())).toEqual({ ok: false, reason: 'failed', errorCode: null });
    expect(sms.messages[3]).toMatchObject({ status: 'failed', error_code: null });
  });

  test('SMS_ALLOWLIST: while the list is set a number outside it is refused before any row or request; a listed number still sends', async () => {
    process.env.SMS_ALLOWLIST = ` ${NUMBER}, +17325550199 `;
    expect(await sendSms(request('status', { to: '+17325550105' }))).toEqual({ ok: false, reason: 'disabled', errorCode: null });
    expect(calls).toEqual([]);
    expect(sms.messages).toEqual([]);
    expect((await sendSms(request('status'))).ok).toBe(true);
    expect(calls.map((c) => c.form.get('To'))).toEqual([NUMBER]);
    expect(sms.messages).toHaveLength(1);
  });

  test('tenant.sms_enabled = false (the runbook pause) refuses every send before the claim row; switched back on, the send goes out', async () => {
    sms.tenantEnabled = false;
    expect(await sendSms(request())).toEqual({ ok: false, reason: 'disabled', errorCode: null });
    expect(calls).toEqual([]);
    expect(sms.messages).toEqual([]);
    sms.tenantEnabled = true;
    expect((await sendSms(request())).ok).toBe(true);
    expect(sms.messages).toHaveLength(1);
  });

  test('copy: typographic punctuation becomes GSM-7, the STOP line survives a long head, one segment at most', () => {
    expect(gsm7('Fixed — please verify… “here’s”')).toBe('Fixed - please verify... "here\'s"');
    const long = fitSms(`RootCause: ${'Very Long Street Name '.repeat(12)}: Scheduled — window given. Open the app for the timeline.`, 'Reply STOP to opt out.');
    expect(long.length).toBeLessThanOrEqual(SMS_SEGMENT);
    expect(long.endsWith('... Reply STOP to opt out.')).toBe(true);
    const copy = statusChangeSms({ address_text: '12 Somerset St' }, 'completed');
    expect(copy).toBe('RootCause: 12 Somerset St: Fixed - please verify. Open the app for the timeline and confirm the fix. Reply STOP to opt out.');
    expect(copy.length).toBeLessThanOrEqual(SMS_SEGMENT);
    expect(statusChangeSms({ address_text: '  ' }, 'rejected')).toMatch(/^RootCause: near you: Not city-owned - here's who owns it\./);
    expect(deliveryStatusOf('accepted')).toBe('queued');
    expect(deliveryStatusOf('Sent')).toBe('sent');
    expect(deliveryStatusOf('read')).toBe('delivered');
    expect(deliveryStatusOf('canceled')).toBe('failed');
    expect(deliveryStatusOf(undefined)).toBe('queued');
    expect(advances('queued', 'sent')).toBe(true);
    expect(advances('delivered', 'sent')).toBe(false);
    expect(advances('failed', 'delivered')).toBe(false);
    expect(advances('sent', 'undelivered')).toBe(true);
  });
});

describe('getSmsRepo', () => {
  test('the test override first, then the dev-memory bundle (ROOTCAUSE_DEV_MEMORY) — never Supabase while a memory bundle is live', () => {
    setRepos(repos);
    try {
      expect(getSmsRepo()).toBe(sms);
      setSmsRepo(null);
      expect(getSmsRepo()).toBe(repos.sms);
    } finally {
      setRepos(null);
      setSmsRepo(sms);
    }
  });
});

describe('POST /api/webhooks/twilio', () => {
  test("the WebCrypto signature equals Node's HMAC-SHA1 over Twilio's documented string (url + sorted key/value pairs), base64", async () => {
    // Twilio's example shape (https://www.twilio.com/docs/usage/webhooks/webhooks-security): query string kept, params sorted by key, values appended raw.
    const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
    const params = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675310', Digits: '1234', From: '+14158675310', To: '+18005551212' };
    const expected = createHmac('sha1', '12345').update(`${url}CallSidCA1234567890ABCDECaller+14158675310Digits1234From+14158675310To+18005551212`).digest('base64');
    expect(await twilioSignature(url, params, '12345')).toBe(expected);
    expect(await twilioSignature(url, { ...params, Digits: '1235' }, '12345')).not.toBe(expected);
    expect(await twilioSignature(url, params, '12346')).not.toBe(expected);
  });

  test('a signed callback advances the sms_message row and the alert_delivery row by provider id; repeats and regressions change nothing; 204 throughout', async () => {
    expect((await sendSms(request('alert', { alertId: 'al_1' }))).ok).toBe(true);
    sms.seedDelivery({ alert_id: 'al_1', user_id: 'u_jane', provider_id: 'SM0001' });
    sms.seedDelivery({ alert_id: 'al_1', user_id: 'u_jane', channel: 'push', provider_id: 'ticket-1' });
    const sent = await signedCallback({ MessageSid: 'SM0001', MessageStatus: 'sent', AccountSid: 'ACtest', From: '+18005550000', To: NUMBER, ApiVersion: '2010-04-01' });
    expect(sent.status).toBe(204);
    expect(sms.messages[0]).toMatchObject({ sid: 'SM0001', status: 'sent' });
    expect(sms.deliveries[0]).toMatchObject({ status: 'sent', provider_id: 'SM0001' });
    expect(typeof sms.deliveries[0].sent_at).toBe('string');
    expect(sms.deliveries[1].status).toBe('queued');

    expect((await signedCallback({ MessageSid: 'SM0001', MessageStatus: 'delivered', AccountSid: 'ACtest' })).status).toBe(204);
    expect(sms.messages[0].status).toBe('delivered');
    expect(sms.deliveries[0].status).toBe('delivered');
    // out of order: a late 'sent' never moves a delivered row back
    expect((await signedCallback({ MessageSid: 'SM0001', MessageStatus: 'sent', AccountSid: 'ACtest' })).status).toBe(204);
    expect(sms.messages[0].status).toBe('delivered');
    expect(sms.deliveries[0].status).toBe('delivered');
    // a SID this server never wrote is still a valid callback
    expect((await signedCallback({ MessageSid: 'SM9999', MessageStatus: 'failed', ErrorCode: '30003' })).status).toBe(204);
    expect((await signedCallback({ MessageStatus: 'failed' })).status).toBe(204);
  });

  test('STOP (21610) switches the account off; a forged or missing signature → 403 and nothing changes; JSON → 400; unconfigured → 503', async () => {
    me.seedExtras('u_jane', { phone_e164: NUMBER, phone_verified_at: NOW, sms_opt_in: true });
    expect((await sendSms(request('status'))).ok).toBe(true);
    const stop = await signedCallback({ MessageSid: 'SM0001', MessageStatus: 'undelivered', ErrorCode: TWILIO.unsubscribedErrorCode });
    expect(stop.status).toBe(204);
    expect(sms.messages[0]).toMatchObject({ status: 'undelivered', error_code: '21610' });
    expect((await me.getPhone('u_jane'))?.sms_opt_in).toBe(false);
    expect((await me.getPhone('u_jane'))?.phone_verified_at).toBe(NOW);

    reply = () => jsonResponse(201, { sid: 'SM0002', status: 'queued' });
    expect((await sendSms(request('status'))).ok).toBe(true);
    const forged = await signedCallback({ MessageSid: 'SM0002', MessageStatus: 'delivered' }, { signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
    expect(forged.status).toBe(403);
    expect((await forged.json()).error.code).toBe('forbidden');
    expect(sms.messages[1].status).toBe('queued');
    expect((await signedCallback({ MessageSid: 'SM0002', MessageStatus: 'delivered' }, { signature: null })).status).toBe(403);
    // the signature is over the configured URL: a callback signed for another URL is forged too
    const other = await twilioSignature('https://evil.example.org/api/webhooks/twilio', { MessageSid: 'SM0002', MessageStatus: 'delivered' }, ENV.TWILIO_AUTH_TOKEN);
    expect((await signedCallback({ MessageSid: 'SM0002', MessageStatus: 'delivered' }, { signature: other })).status).toBe(403);
    // tampered parameters do not match the signature either
    const good = await twilioSignature(WEBHOOK_URL, { MessageSid: 'SM0002', MessageStatus: 'sent' }, ENV.TWILIO_AUTH_TOKEN);
    expect((await signedCallback({ MessageSid: 'SM0002', MessageStatus: 'delivered' }, { signature: good })).status).toBe(403);
    expect(sms.messages[1].status).toBe('queued');

    expect((await WEBHOOK(new Request(WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json', [TWILIO_SIGNATURE_HEADER]: 'x' }, body: '{"MessageSid":"SM0002"}' }))).status).toBe(400);
    delete process.env.TWILIO_WEBHOOK_URL;
    const unconfigured = await signedCallback({ MessageSid: 'SM0002', MessageStatus: 'delivered' });
    expect(unconfigured.status).toBe(503);
    expect((await unconfigured.json()).error.code).toBe('misconfigured');
  });
});

describe('notifyStatusChange SMS leg (plan §11 "SMS only if no device")', () => {
  let engagement: MemoryEngagementRepo;
  let pushed: string[];

  const input = (over: Partial<CreateReportInput> = {}): CreateReportInput => ({ clientDraftId: 'd_m2k9x1a3_7f3kq', category: 'vegetation', subtype: 'root_heave', severityResident: 2, injuryFlag: 'no', reporterDisplay: 'named', lat: 40.4862, lng: -74.4518, accuracyM: 8, locationConfirmed: true, addressText: '12 Somerset St', photoIds: [], capturedAt: NOW, ...over });

  async function seed(): Promise<ReportRow> {
    repos.users.seed({ id: 'u_bob', display_name: 'Bob Smith' });
    repos.users.seed({ id: 'u_nophone', display_name: 'No Phone' });
    repos.users.seed({ id: 'u_pending', display_name: 'Pending Phone' });
    repos.users.seed({ id: 'u_optout', display_name: 'Verified Not Opted In' });
    repos.users.seed({ id: 'u_quiet', display_name: 'Quiet Opted In' });
    engagement = new MemoryEngagementRepo(repos.users, repos.reports);
    setEngagementRepo(engagement);
    engagement.seedDevice({ user_id: 'u_bob', expo_push_token: 'ExponentPushToken[bob]', platform: 'ios' });
    engagement.seedContext('u_quiet', { quiet_hours: { start: '22:00', end: '07:00' } });
    me.seedExtras('u_jane', { phone_e164: NUMBER, phone_verified_at: NOW, sms_opt_in: true });
    me.seedExtras('u_bob', { phone_e164: '+17325550102', phone_verified_at: NOW, sms_opt_in: true }); // has a device: push only
    me.seedExtras('u_pending', { phone_e164: '+17325550103', phone_verified_at: null, sms_opt_in: false });
    me.seedExtras('u_optout', { phone_e164: '+17325550104', phone_verified_at: NOW, sms_opt_in: false });
    me.seedExtras('u_quiet', { phone_e164: '+17325550105', phone_verified_at: NOW, sms_opt_in: true });
    pushed = [];
    setPushSender({
      async send(chunk) {
        pushed.push(...chunk.map((m) => String(m.to)));
        return chunk.map((m) => ({ status: 'ok' as const, id: `t_${String(m.to)}` }));
      },
    });
    const { row } = await repos.reports.create(input(), { userId: 'u_jane', role: 'resident', now: NOW, requestId: 'seed' });
    for (const id of ['u_bob', 'u_nophone', 'u_pending', 'u_optout', 'u_quiet']) await engagement.follow(row.id, id, NOW);
    return row;
  }

  test('after the pushes, one text per verified opted-in account without a device; quiet hours, pending numbers and withdrawn consent get none', async () => {
    const row = await seed();
    const res = await notifyStatusChange(row, 'scheduled', 'completed', { now: est(23) });
    expect(res).toMatchObject({ recipients: 6, quiet: 1, noDevice: 4, pushed: 1, smsEligible: 1, sms: 1 });
    expect(pushed).toEqual(['ExponentPushToken[bob]']);
    expect(calls).toHaveLength(1);
    expect(calls[0].form.get('To')).toBe(NUMBER);
    expect(calls[0].form.get('Body')).toBe('RootCause: 12 Somerset St: Fixed - please verify. Open the app for the timeline and confirm the fix. Reply STOP to opt out.');
    expect(sms.messages).toHaveLength(1);
    expect(sms.messages[0]).toMatchObject({ kind: 'status', user_id: 'u_jane', alert_id: null, to_last4: '0100', sid: 'SM0001' });
    // by day the quiet-hours account is awake and texted too
    reply = () => jsonResponse(201, { sid: 'SM0002', status: 'queued' });
    const day = await notifyStatusChange(row, 'completed', 'verified', { now: est(12) });
    expect(day).toMatchObject({ quiet: 0, noDevice: 5, smsEligible: 2, sms: 2 });
    expect(calls.map((c) => c.form.get('To')).sort()).toEqual([NUMBER, NUMBER, '+17325550105'].sort());
  });

  test('with SMS_ALLOWLIST set only the listed account is texted; the other eligible account is counted, not sent', async () => {
    const row = await seed();
    process.env.SMS_ALLOWLIST = NUMBER;
    const res = await notifyStatusChange(row, 'completed', 'verified', { now: est(12) });
    expect(res).toMatchObject({ pushed: 1, smsEligible: 2, sms: 1 });
    expect(calls.map((c) => c.form.get('To'))).toEqual([NUMBER]);
    expect(sms.messages).toHaveLength(1);
    expect(sms.messages[0]).toMatchObject({ user_id: 'u_jane', to_last4: '0100' });
  });

  test('with SMS off the eligible accounts are counted and nobody is texted; a failing lookup never undoes the push leg', async () => {
    const row = await seed();
    process.env.SMS_ENABLED = 'false';
    const res = await notifyStatusChange(row, 'new', 'triaged', { now: est(12) });
    expect(res).toMatchObject({ pushed: 1, smsEligible: 2, sms: 0 });
    expect(calls).toEqual([]);
    expect(sms.messages).toEqual([]);
    me.getPhone = async () => {
      throw new Error('db down');
    };
    const broken = await notifyStatusChange(row, 'triaged', 'assessed', { now: est(12) });
    expect(broken).toMatchObject({ pushed: 1, smsEligible: 0, sms: 0 });
  });
});
