/**
 * /api/v1/me/phone and /api/v1/me/phone/check against the memory repos with a fake Twilio Verify (plan §14 route
 * tests "OTP send/verify limits"; §7 /me/phone rows; §23.H Twilio Verify; spec R14): 401 without a session · 400 for a
 * number that is not E.164 or a code that is not 6 digits · 503 when Verify is not configured (no request leaves) ·
 * start → Verify is asked with Basic auth and the number is stored pending (phoneLast4, phoneVerified false, opt-in
 * reset) · check with the right code → the MeProfile shows phoneVerified true and PATCH /me smsOptIn works · a wrong
 * code → 400, an expired one → 409, Twilio's check cap → 429 · 429 after PHONE_START_LIMIT.perWindow starts an hour,
 * per account · 403 for an auditor · the full number never leaves through a response or a log line.
 */
import { GET as GET_ME, PATCH as PATCH_ME } from '@/app/api/v1/me+api';
import { PHONE_START_LIMIT, POST as POST_START } from '@/app/api/v1/me/phone+api';
import { POST as POST_CHECK } from '@/app/api/v1/me/phone/check+api';
import { MeProfileSchema } from '@/domain/types';
import { setTestUser } from '@/server/auth';
import { setLogSink } from '@/server/log';
import { MemoryRateLimiter, setRateLimiter } from '@/server/ratelimit';
import { setMeRepo } from '@/server/repos/me';
import { createMemoryRepos, type MemoryRepos } from '@/server/repos/memory';
import { MemoryMeRepo } from '@/server/repos/memory/me';
import { setRepos } from '@/server/repos/types';
import { TWILIO, setTwilioFetch } from '@/server/sms';

const BASE = 'http://localhost/api/v1/me';
const NOW = '2026-10-05T12:00:00.000Z';
const JANE = { id: 'u_jane', display_name: 'Jane Doe' };
const BOB = { id: 'u_bob', display_name: 'Bob Ray' };
const NUMBER = '+17325550100';
const CODE = '123456';
/** The stored number and its column name never leave (plan §12); the last four digits may. */
const FORBIDDEN = /phone_e164|17325550100|7325550100/;

const ENV = { SUPABASE_URL: 'https://test-project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-for-tests', TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'twilio-token', TWILIO_VERIFY_SERVICE_SID: 'VAtest' };

const req = (path: string, body: unknown, method = 'POST') =>
  new Request(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const start = (phone: unknown) => POST_START(req('/phone', typeof phone === 'string' && phone.startsWith('{') ? phone : { phone }));
const check = (code: unknown) => POST_CHECK(req('/phone/check', typeof code === 'string' && code.startsWith('{') ? code : { code }));

interface TwilioCall {
  url: string;
  headers: Record<string, string>;
  form: URLSearchParams;
}

let repos: MemoryRepos;
let me: MemoryMeRepo;
let now: number;
let calls: TwilioCall[];
let lines: string[];
let checkReply: (form: URLSearchParams) => Response;
let startReply: (form: URLSearchParams) => Response;
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

beforeAll(() => {
  lines = [];
  setLogSink((line) => lines.push(line));
});
afterAll(() => {
  setLogSink(null);
  setRepos(null);
  setMeRepo(null);
  setRateLimiter(null);
  setTestUser(undefined);
  setTwilioFetch(null);
});

beforeEach(() => {
  restoreEnv = withEnv(ENV);
  repos = createMemoryRepos();
  repos.users.seed(JANE);
  repos.users.seed(BOB);
  me = new MemoryMeRepo(repos);
  setRepos(repos);
  setMeRepo(me);
  now = Date.parse(NOW);
  setRateLimiter(new MemoryRateLimiter(() => now));
  setTestUser({ userId: JANE.id, role: 'resident' });
  lines.length = 0;
  calls = [];
  startReply = () => jsonResponse(201, { sid: 'VE0001', status: 'pending' });
  checkReply = (form) => jsonResponse(200, { sid: 'VE0001', status: form.get('Code') === CODE ? 'approved' : 'pending', valid: form.get('Code') === CODE });
  setTwilioFetch(async (url, init) => {
    const form = new URLSearchParams(String(init.body));
    calls.push({ url, headers: init.headers as Record<string, string>, form });
    return url.endsWith('/VerificationCheck') ? checkReply(form) : startReply(form);
  });
});

afterEach(() => restoreEnv());

test('401 without a session on both routes', async () => {
  setTestUser(null);
  for (const res of [await start(NUMBER), await check(CODE)]) {
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
  }
  expect(calls).toEqual([]);
});

test('400 for a number that is not E.164 or a code that is not six digits; nothing is sent', async () => {
  for (const bad of ['7325550100', '+0732555010', 'call me', '', '+1', '{nope', 12]) {
    const res = await start(bad);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  }
  expect((await POST_START(req('/phone', {}))).status).toBe(400);
  for (const bad of ['12345', '1234567', 'abcdef', '', '{nope']) expect((await check(bad)).status).toBe(400);
  expect(calls).toEqual([]);
  expect(await me.getPhone(JANE.id)).toBeNull();
});

test('503 when Verify is not configured on this deploy, and no request leaves', async () => {
  delete process.env.TWILIO_VERIFY_SERVICE_SID;
  const res = await start(NUMBER);
  expect(res.status).toBe(503);
  expect((await res.json()).error.code).toBe('misconfigured');
  expect(calls).toEqual([]);
  expect(await me.getPhone(JANE.id)).toBeNull();
});

test('start → Verify asked with Basic auth, number stored pending; wrong code 400; right code → profile verified → SMS opt-in works; a new number resets both', async () => {
  const started = await start(' +1 (732) 555-0100 ');
  expect(started.status).toBe(200);
  expect(await started.json()).toEqual({ ok: true, last4: '0100' });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(`${TWILIO.verifyBase}/Services/VAtest/Verifications`);
  expect(calls[0].headers.authorization).toBe(`Basic ${btoa('ACtest:twilio-token')}`);
  expect(calls[0].headers['content-type']).toBe('application/x-www-form-urlencoded');
  expect(calls[0].form.get('To')).toBe(NUMBER);
  expect(calls[0].form.get('Channel')).toBe('sms');
  expect(await me.getPhone(JANE.id)).toEqual({ tenant_id: 'pilot', phone_e164: NUMBER, phone_verified_at: null, sms_opt_in: false });

  const pending = await (await GET_ME(req('', undefined, 'GET'))).json();
  expect(pending).toMatchObject({ phoneVerified: false, phoneLast4: '0100', smsOptIn: false });
  expect(JSON.stringify(pending)).not.toMatch(FORBIDDEN);
  const refused = await PATCH_ME(req('', { smsOptIn: true }, 'PATCH'));
  expect(refused.status).toBe(400);

  const wrong = await check('000000');
  expect(wrong.status).toBe(400);
  expect((await wrong.json()).error.message).toMatch(/did not work/);
  expect(calls[1].url).toBe(`${TWILIO.verifyBase}/Services/VAtest/VerificationCheck`);
  expect(calls[1].form.get('To')).toBe(NUMBER);
  expect(calls[1].form.get('Code')).toBe('000000');
  expect((await me.getPhone(JANE.id))?.phone_verified_at).toBeNull();

  const right = await check(' 123 456 ');
  expect(right.status).toBe(200);
  const profile = await right.json();
  expect(MeProfileSchema.safeParse(profile).success).toBe(true);
  expect(profile).toMatchObject({ userId: JANE.id, phoneVerified: true, phoneLast4: '0100', smsOptIn: false });
  expect(JSON.stringify(profile)).not.toMatch(FORBIDDEN);
  expect(typeof (await me.getPhone(JANE.id))?.phone_verified_at).toBe('string');

  const optedIn = await PATCH_ME(req('', { smsOptIn: true }, 'PATCH'));
  expect(optedIn.status).toBe(200);
  expect((await optedIn.json())).toMatchObject({ phoneVerified: true, smsOptIn: true });

  // Already verified: a retried check answers the profile without asking Twilio again.
  const again = await check(CODE);
  expect(again.status).toBe(200);
  expect(calls).toHaveLength(3);

  // A new number starts over: not verified, consent withdrawn until the new number is verified.
  expect((await start('+17325550199')).status).toBe(200);
  expect(await me.getPhone(JANE.id)).toEqual({ tenant_id: 'pilot', phone_e164: '+17325550199', phone_verified_at: null, sms_opt_in: false });
  expect(await (await GET_ME(req('', undefined, 'GET'))).json()).toMatchObject({ phoneVerified: false, phoneLast4: '0199', smsOptIn: false });

  for (const line of lines) expect(line).not.toMatch(FORBIDDEN);
});

test('check without a number on file → 400; expired → 409; Twilio check cap → 429; Twilio send cap → 429; a refused number → 400', async () => {
  const none = await check(CODE);
  expect(none.status).toBe(400);
  expect((await none.json()).error.message).toMatch(/Add a phone number first/);
  expect((await start(NUMBER)).status).toBe(200);

  checkReply = () => jsonResponse(404, { code: 20404, message: 'The requested resource was not found', status: 404 });
  const expired = await check(CODE);
  expect(expired.status).toBe(409);
  expect((await expired.json()).error.code).toBe('conflict');

  checkReply = () => jsonResponse(429, { code: 60202, message: 'Max check attempts reached', status: 429 });
  const capped = await check(CODE);
  expect(capped.status).toBe(429);
  expect(capped.headers.get('retry-after')).toBeTruthy();
  expect((await me.getPhone(JANE.id))?.phone_verified_at).toBeNull();

  startReply = () => jsonResponse(429, { code: 60203, message: 'Max send attempts reached', status: 429 });
  expect((await start(NUMBER)).status).toBe(429);
  startReply = () => jsonResponse(400, { code: 60200, message: 'Invalid parameter', status: 400 });
  const refused = await start('+15005550006');
  expect(refused.status).toBe(400);
  expect((await refused.json()).error.message).toMatch(/could not receive a code/);
  // the pending number is untouched by a refused start
  expect((await me.getPhone(JANE.id))?.phone_e164).toBe(NUMBER);

  setTwilioFetch(async () => {
    throw new Error('twilio down');
  });
  expect((await start(NUMBER)).status).toBe(500);
  expect((await check(CODE)).status).toBe(500);
});

test('429 after PHONE_START_LIMIT.perWindow starts in an hour, per account, with Retry-After; a tombstone and an auditor are refused', async () => {
  for (let i = 0; i < PHONE_START_LIMIT.perWindow; i++) expect((await start(NUMBER)).status).toBe(200);
  const limited = await start(NUMBER);
  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).toBe(String(PHONE_START_LIMIT.windowSec));
  expect((await limited.json()).error.code).toBe('rate_limited');
  expect(calls).toHaveLength(PHONE_START_LIMIT.perWindow);
  setTestUser({ userId: BOB.id, role: 'resident' });
  expect((await start(NUMBER)).status).toBe(200);
  setTestUser({ userId: JANE.id, role: 'resident' });
  now += PHONE_START_LIMIT.windowSec * 1000 + 1;
  expect((await start(NUMBER)).status).toBe(200);

  me.seedExtras(BOB.id, { deleted_at: NOW });
  setTestUser({ userId: BOB.id, role: 'resident' });
  expect((await start(NUMBER)).status).toBe(401);
  expect((await check(CODE)).status).toBe(401);
  repos.users.seed({ id: 'u_audit', role: 'auditor' });
  setTestUser({ userId: 'u_audit', role: 'auditor' });
  expect((await start(NUMBER)).status).toBe(403);
  expect((await check(CODE)).status).toBe(403);
});
