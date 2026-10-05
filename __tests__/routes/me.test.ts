/**
 * /api/v1/me and its sub-routes against the memory repos (plan §14 route tests; §7 /me rows; §23.C deletion order):
 * 401 without a session on every route · GET profile shape and stats · PATCH validation · DELETE de-identifies (votes
 * summed into orphan_vote_weight and removed, reports anonymous, photo uploader cleared, comments "former user",
 * follows/devices/watch areas gone, tombstone deleted_at, Apple revoke best effort) and only then deletes the auth
 * user · watch areas CRUD, cap and ownership · devices upserted by token · own reports through the public projection ·
 * export limited to 2/day · apple-link exchange and sealed storage.
 */
import { DELETE as DELETE_ME, GET as GET_ME, PATCH as PATCH_ME } from '@/app/api/v1/me+api';
import { APPLE_LINK_LIMIT, POST as POST_APPLE_LINK } from '@/app/api/v1/me/apple-link+api';
import { POST as POST_DEVICE } from '@/app/api/v1/me/devices+api';
import { EXPORT_LIMIT, GET as GET_EXPORT } from '@/app/api/v1/me/export+api';
import { GET as GET_MY_REPORTS } from '@/app/api/v1/me/reports+api';
import { GET as GET_WATCH, POST as POST_WATCH, WATCH_AREA_MAX } from '@/app/api/v1/me/watch-areas+api';
import { DELETE as DELETE_WATCH, PATCH as PATCH_WATCH } from '@/app/api/v1/me/watch-areas/[id]+api';
import { MeProfileSchema, PublicReportSchema, WatchAreaSchema, type CreateReportInput, type DeviceInput, type WatchAreaInput } from '@/domain/types';
import { APPLE, openToken, sealToken, type AppleEnv } from '@/server/apple';
import { setTestUser } from '@/server/auth';
import { setLogSink } from '@/server/log';
import { toPublicReport } from '@/server/public';
import { MemoryRateLimiter, setRateLimiter } from '@/server/ratelimit';
import { setMeRepo } from '@/server/repos/me';
import { createMemoryRepos, type MemoryRepos } from '@/server/repos/memory';
import { MemoryMeRepo } from '@/server/repos/memory/me';
import { MEMORY_EPOCH } from '@/server/repos/memory/users';
import { setRepos } from '@/server/repos/types';

const BASE = 'http://localhost/api/v1/me';
const NOW = '2026-10-05T12:00:00.000Z';
const JANE = { id: 'u_jane', display_name: 'Jane Doe' };
const BOB = { id: 'u_bob', display_name: 'Bob Ray' };
/** Nothing private may leave through these routes (plan §12): precise home, phone, Apple token, install id, storage keys. */
const FORBIDDEN = /home_geom|phone_e164|apple_refresh_token|install_id|storage_key|thumb_key|client_draft_id|clientDraftId|uploader_id|reporter_id/;

const req = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  new Request(`${BASE}${path}`, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body) });

const watch = (over: Partial<WatchAreaInput> = {}): WatchAreaInput => ({ kind: 'home', label: 'Home', lat: 40.4862, lng: -74.4518, radiusM: 400, categories: ['vegetation', 'sidewalk'], schedule: null, ...over });
const device = (over: Partial<DeviceInput> = {}): DeviceInput => ({ expoPushToken: 'ExponentPushToken[abcdefghijklmnop]', platform: 'ios', installId: 'i_m2k9x1a3_7f3kq', ...over });

let repos: MemoryRepos;
let me: MemoryMeRepo;
let limiter: MemoryRateLimiter;
let now: number;
let draftSeq = 0;

async function fileReport(userId: string, over: Partial<CreateReportInput> = {}) {
  const input: CreateReportInput = {
    clientDraftId: `d_${String(++draftSeq).padStart(4, '0')}_abcdefgh`,
    category: 'vegetation',
    subtype: 'root_heave',
    severityResident: 2,
    injuryFlag: 'no',
    reporterDisplay: 'named',
    lat: 40.4862 + draftSeq * 0.002,
    lng: -74.4518,
    accuracyM: 8,
    locationConfirmed: true,
    addressText: `${draftSeq} Somerset St`,
    photoIds: [],
    capturedAt: NOW,
    ...over,
  };
  const { row } = await repos.reports.create(input, { userId, role: 'resident', now: new Date(Date.parse(NOW) + draftSeq * 60_000).toISOString(), requestId: `req-${draftSeq}` });
  return row;
}

/** A throwaway Apple key so the exchange and revoke paths run end to end against a mocked fetch. */
async function appleTestEnv(): Promise<AppleEnv & { env: Record<string, string> }> {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key.privateKey));
  const b64 = btoa(String.fromCharCode(...der));
  const pem = `-----BEGIN PRIVATE KEY-----\n${(b64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----`;
  return { teamId: 'TEAM123456', keyId: 'KEY1234567', privateKeyPem: pem, clientId: APPLE.defaultClientId, env: { APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567', APPLE_PRIVATE_KEY: pem } };
}

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

beforeAll(() => setLogSink(() => {}));
afterAll(() => {
  setLogSink(null);
  setRepos(null);
  setMeRepo(null);
  setRateLimiter(null);
  setTestUser(undefined);
});

beforeEach(() => {
  repos = createMemoryRepos();
  repos.users.seed(JANE);
  repos.users.seed(BOB);
  me = new MemoryMeRepo(repos);
  setRepos(repos);
  setMeRepo(me);
  now = Date.parse(NOW);
  limiter = new MemoryRateLimiter(() => now);
  setRateLimiter(limiter);
  setTestUser({ userId: JANE.id, role: 'resident' });
  draftSeq = 0;
});

describe('every /me route needs a session (AC22)', () => {
  test.each([
    ['GET /me', () => GET_ME(req(''))],
    ['PATCH /me', () => PATCH_ME(req('', { method: 'PATCH', body: { displayName: 'x' } }))],
    ['DELETE /me', () => DELETE_ME(req('', { method: 'DELETE' }))],
    ['GET /me/watch-areas', () => GET_WATCH(req('/watch-areas'))],
    ['POST /me/watch-areas', () => POST_WATCH(req('/watch-areas', { method: 'POST', body: watch() }))],
    ['PATCH /me/watch-areas/:id', () => PATCH_WATCH(req('/watch-areas/wa_000001', { method: 'PATCH', body: { radiusM: 500 } }), { id: 'wa_000001' })],
    ['DELETE /me/watch-areas/:id', () => DELETE_WATCH(req('/watch-areas/wa_000001', { method: 'DELETE' }), { id: 'wa_000001' })],
    ['POST /me/devices', () => POST_DEVICE(req('/devices', { method: 'POST', body: device() }))],
    ['GET /me/reports', () => GET_MY_REPORTS(req('/reports'))],
    ['GET /me/export', () => GET_EXPORT(req('/export'))],
    ['POST /me/apple-link', () => POST_APPLE_LINK(req('/apple-link', { method: 'POST', body: { authorizationCode: 'c0de' } }))],
  ])('%s → 401 without a session', async (_name, call) => {
    setTestUser(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
  });
});

describe('GET /api/v1/me', () => {
  test('profile shape: role from app_user, stats from own reports and votes, watch areas, nothing private', async () => {
    me.seedExtras(JANE.id, { email: 'jane@example.org', quiet_hours: { start: '22:00', end: '07:00' } });
    const first = await fileReport(JANE.id);
    await fileReport(JANE.id);
    await fileReport(JANE.id, { reporterDisplay: 'anonymous' });
    repos.reports.rows.find((r) => r.id === first.id)!.status = 'verified';
    me.votes.push({ report_id: first.id, user_id: JANE.id, weight: 1, created_at: NOW }, { report_id: 'rc_other', user_id: JANE.id, weight: 0.6, created_at: NOW });
    await me.createWatchArea(JANE.id, watch());
    const res = await GET_ME(req('', { headers: { 'x-request-id': 'req-me' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('req-me');
    const body = await res.json();
    expect(MeProfileSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ userId: JANE.id, role: 'resident', displayName: 'Jane Doe', email: 'jane@example.org', provider: 'email', phoneVerified: false, smsOptIn: false, quietHours: { start: '22:00', end: '07:00' }, stats: { filed: 2, resolved: 1, votes: 2 }, createdAt: MEMORY_EPOCH });
    expect(body.watchAreas).toHaveLength(1);
    expect(body.watchAreas[0]).toMatchObject({ id: 'wa_000001', kind: 'home', radiusM: 400 });
    expect(JSON.stringify(body)).not.toMatch(FORBIDDEN);
  });

  test('a de-identified tombstone is no longer an account: 401', async () => {
    me.seedExtras(JANE.id, { deleted_at: NOW });
    const res = await GET_ME(req(''));
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/deleted/);
  });
});

describe('PATCH /api/v1/me', () => {
  const patch = (body: unknown) => PATCH_ME(req('', { method: 'PATCH', body }));

  test('400 for a non-JSON body, an empty patch, a bad shape, a long name and SMS opt-in without a verified phone', async () => {
    expect((await patch('{nope')).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ unrelated: 1 })).status).toBe(400);
    expect((await patch({ quietHours: { start: 22 } })).status).toBe(400);
    expect((await patch({ displayName: 'x'.repeat(61) })).status).toBe(400);
    const sms = await patch({ smsOptIn: true });
    expect(sms.status).toBe(400);
    expect((await sms.json()).error.message).toMatch(/smsOptIn/);
    expect((await repos.users.getById(JANE.id))?.display_name).toBe('Jane Doe');
  });

  test('200 changes only what is named and answers with the profile', async () => {
    const res = await patch({ displayName: '  Jane D.  ', quietHours: null });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(MeProfileSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ displayName: 'Jane D.', quietHours: null, smsOptIn: false });
    expect((await repos.users.getById(JANE.id))?.display_name).toBe('Jane D.');
    expect((await (await patch({ displayName: '' })).json()).displayName).toBeNull();
    expect((await (await patch({ quietHours: { start: '23:00', end: '06:00' } })).json()).quietHours).toEqual({ start: '23:00', end: '06:00' });
    me.seedExtras(JANE.id, { phone_verified_at: NOW });
    expect((await (await patch({ smsOptIn: true })).json())).toMatchObject({ phoneVerified: true, smsOptIn: true });
    expect((await (await patch({ smsOptIn: false })).json()).smsOptIn).toBe(false);
  });
});

describe('DELETE /api/v1/me (plan §23.C)', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
    await fileReport(JANE.id); // rc_000001
    await fileReport(JANE.id, { reporterDisplay: 'initials' }); // rc_000002
    await fileReport(JANE.id, { reporterDisplay: 'anonymous' }); // rc_000003
    await fileReport(BOB.id); // rc_000004
    repos.reports.rows[0].photos.push({ id: 'ph_1', phase: 'before', visibility: 'public', uploader_id: JANE.id, url: 'u', thumb_url: 't' });
    me.votes.push({ report_id: 'rc_000001', user_id: JANE.id, weight: 1, created_at: NOW }, { report_id: 'rc_000004', user_id: JANE.id, weight: 0.6, created_at: NOW }, { report_id: 'rc_000004', user_id: BOB.id, weight: 1, created_at: NOW });
    me.follows.push({ report_id: 'rc_000004', user_id: JANE.id }, { report_id: 'rc_000001', user_id: BOB.id });
    me.comments.push({ id: 'c_1', report_id: 'rc_000004', user_id: JANE.id, body: 'Still there this morning', created_at: NOW });
    await me.upsertDevice(JANE.id, device(), NOW);
    await me.createWatchArea(JANE.id, watch());
    await me.createWatchArea(JANE.id, watch({ kind: 'work', label: 'Work' }));
    await me.createWatchArea(BOB.id, watch({ label: "Bob's" }));
    me.seedExtras(JANE.id, { email: 'jane@example.org', quiet_hours: { start: '22:00', end: '07:00' }, phone_verified_at: NOW, sms_opt_in: true });
  });

  afterEach(() => fetchSpy.mockRestore());

  test('204: votes become orphan weight, reports and photos lose the link, comments survive as "former user", the rest goes, the row is a tombstone', async () => {
    const res = await DELETE_ME(req('', { method: 'DELETE' }));
    expect(res.status).toBe(204);
    const rows = repos.reports.rows;
    expect(rows[0]).toMatchObject({ id: 'rc_000001', reporter_id: null, reporter_display: 'anonymous', reporter_display_name: null });
    expect(rows[1]).toMatchObject({ id: 'rc_000002', reporter_id: null, reporter_display: 'anonymous' });
    expect(rows[2]).toMatchObject({ id: 'rc_000003', reporter_id: null });
    expect(rows[3]).toMatchObject({ id: 'rc_000004', reporter_id: BOB.id, reporter_display: 'named', vote_count: 1 });
    expect(rows[0].photos[0].uploader_id).toBeNull();
    // votes: summed per report, rows removed, Bob's untouched
    expect(me.votes).toEqual([{ report_id: 'rc_000004', user_id: BOB.id, weight: 1, created_at: NOW }]);
    expect(me.orphanVoteWeight.get('rc_000001')).toBe(1);
    expect(me.orphanVoteWeight.get('rc_000004')).toBe(0.6);
    expect(me.comments[0]).toMatchObject({ user_id: null, body: 'Still there this morning' });
    expect(me.follows).toEqual([{ report_id: 'rc_000001', user_id: BOB.id }]);
    expect(me.devices).toEqual([]);
    expect(await me.listWatchAreas(JANE.id)).toEqual([]);
    expect(await me.listWatchAreas(BOB.id)).toHaveLength(1);
    const row = await me.getMe(JANE.id);
    expect(row).toMatchObject({ display_name: null, quiet_hours: null, phone_verified_at: null, sms_opt_in: false, apple_refresh_token: null });
    expect(typeof row?.deleted_at).toBe('string');
    expect(me.deletedAuthUsers).toEqual([JANE.id]);
    // the public projection of a de-identified report reads as anonymous
    expect(toPublicReport(rows[0])).toMatchObject({ reporterDisplay: 'anonymous', reporterName: null });
    // no Apple token → Apple is never called
    expect(fetchSpy).not.toHaveBeenCalled();
    // the account is gone for the API too
    expect((await GET_ME(req(''))).status).toBe(401);
    expect((await (await GET_MY_REPORTS(req('/reports'))).json()).reports).toEqual([]);
  });

  test('revokes the Apple refresh token first, best effort: the sealed token is opened and posted to /auth/revoke; a failing Apple does not block deletion', async () => {
    const apple = await appleTestEnv();
    const restore = withEnv(apple.env);
    try {
      const sealed = await sealToken('r_refresh_123');
      expect(sealed).not.toContain('r_refresh_123');
      await me.setAppleRefreshToken(JANE.id, sealed);
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }));
      const res = await DELETE_ME(req('', { method: 'DELETE' }));
      expect(res.status).toBe(204);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(APPLE.revokeUrl);
      const form = new URLSearchParams(String(init.body));
      expect(form.get('token')).toBe('r_refresh_123');
      expect(form.get('token_type_hint')).toBe('refresh_token');
      expect(form.get('client_id')).toBe(APPLE.defaultClientId);
      expect(form.get('client_secret')?.split('.')).toHaveLength(3);
      expect(me.deletedAuthUsers).toEqual([JANE.id]);
      // a second account with Apple whose revoke call fails: de-identified and deleted anyway
      await me.setAppleRefreshToken(BOB.id, await sealToken('r_bob'));
      setTestUser({ userId: BOB.id, role: 'resident' });
      fetchSpy.mockRejectedValueOnce(new Error('apple down'));
      expect((await DELETE_ME(req('', { method: 'DELETE' }))).status).toBe(204);
      expect(me.deletedAuthUsers).toEqual([JANE.id, BOB.id]);
    } finally {
      restore();
    }
  });

  test('500 when the auth user cannot be deleted; the data is already de-identified and a retry completes', async () => {
    let attempts = 0;
    me.deleteAuthUser = async (userId) => {
      attempts++;
      if (attempts === 1) return false;
      me.deletedAuthUsers.push(userId);
      return true;
    };
    const first = await DELETE_ME(req('', { method: 'DELETE' }));
    expect(first.status).toBe(500);
    expect((await first.json()).error.code).toBe('internal');
    expect(repos.reports.rows[0].reporter_id).toBeNull();
    expect((await me.getMe(JANE.id))?.deleted_at).toBeTruthy();
    expect((await DELETE_ME(req('', { method: 'DELETE' }))).status).toBe(204);
    expect(me.deletedAuthUsers).toEqual([JANE.id]);
  });

  test('404 for an id without an app_user row', async () => {
    setTestUser({ userId: 'u_ghost', role: 'resident' });
    expect((await DELETE_ME(req('', { method: 'DELETE' }))).status).toBe(404);
  });
});

describe('watch areas', () => {
  const post = (body: unknown) => POST_WATCH(req('/watch-areas', { method: 'POST', body }));
  const patch = (id: string, body: unknown) => PATCH_WATCH(req(`/watch-areas/${id}`, { method: 'PATCH', body }), { id });
  const del = (id: string) => DELETE_WATCH(req(`/watch-areas/${id}`, { method: 'DELETE' }), { id });

  test('create, list, update, delete — own areas only', async () => {
    const created = await post(watch());
    expect(created.status).toBe(201);
    const { watchArea } = await created.json();
    expect(WatchAreaSchema.safeParse(watchArea).success).toBe(true);
    expect(watchArea).toMatchObject({ id: 'wa_000001', kind: 'home', label: 'Home', radiusM: 400, categories: ['vegetation', 'sidewalk'], schedule: null });
    expect((await (await GET_WATCH(req('/watch-areas'))).json()).watchAreas).toEqual([watchArea]);

    const updated = await patch('wa_000001', { radiusM: 800, categories: [] });
    expect(updated.status).toBe(200);
    expect((await updated.json()).watchArea).toMatchObject({ id: 'wa_000001', radiusM: 800, categories: [], label: 'Home', lat: 40.4862 });
    expect((await patch('wa_000001', {})).status).toBe(400);
    expect((await patch('wa_000001', { radiusM: 50 })).status).toBe(400);
    expect((await patch('wa_999999', { radiusM: 500 })).status).toBe(404);

    setTestUser({ userId: BOB.id, role: 'resident' });
    expect((await patch('wa_000001', { radiusM: 500 })).status).toBe(404);
    expect((await del('wa_000001')).status).toBe(404);
    expect((await (await GET_WATCH(req('/watch-areas'))).json()).watchAreas).toEqual([]);

    setTestUser({ userId: JANE.id, role: 'resident' });
    expect((await del('wa_000001')).status).toBe(204);
    expect((await del('wa_000001')).status).toBe(404);
    expect((await (await GET_WATCH(req('/watch-areas'))).json()).watchAreas).toEqual([]);
  });

  test('400 for invalid input and beyond the cap; 403 for an auditor', async () => {
    expect((await post({ ...watch(), radiusM: 50 })).status).toBe(400);
    expect((await post({ ...watch(), radiusM: 3100 })).status).toBe(400);
    expect((await post({ ...watch(), kind: 'school' })).status).toBe(400);
    expect((await post({ ...watch(), lat: 91 })).status).toBe(400);
    expect((await post({ ...watch(), label: 'x'.repeat(61) })).status).toBe(400);
    expect((await post({ ...watch(), categories: ['lava'] })).status).toBe(400);
    for (let i = 0; i < WATCH_AREA_MAX; i++) expect((await post(watch({ label: `Area ${i}` }))).status).toBe(201);
    const over = await post(watch({ label: 'One too many' }));
    expect(over.status).toBe(400);
    expect((await over.json()).error.message).toMatch(new RegExp(`${WATCH_AREA_MAX} watch areas`));
    repos.users.seed({ id: 'u_audit', role: 'auditor' });
    setTestUser({ userId: 'u_audit', role: 'auditor' });
    expect((await post(watch())).status).toBe(403);
    expect((await GET_WATCH(req('/watch-areas'))).status).toBe(200);
  });
});

describe('POST /api/v1/me/devices', () => {
  const post = (body: unknown) => POST_DEVICE(req('/devices', { method: 'POST', body }));

  test('upserts by push token: a second sign-in on the same phone moves the token', async () => {
    const res = await post(device());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(me.devices).toHaveLength(1);
    expect(me.devices[0]).toMatchObject({ user_id: JANE.id, platform: 'ios', install_id: 'i_m2k9x1a3_7f3kq' });
    setTestUser({ userId: BOB.id, role: 'resident' });
    expect((await post(device({ platform: 'android' }))).status).toBe(200);
    expect(me.devices).toHaveLength(1);
    expect(me.devices[0]).toMatchObject({ user_id: BOB.id, platform: 'android' });
    expect((await post(device({ expoPushToken: 'ExponentPushToken[second-token-xyz]' }))).status).toBe(200);
    expect(me.devices).toHaveLength(2);
  });

  test('400 for a short token or an unknown platform; 403 for an auditor', async () => {
    expect((await post(device({ expoPushToken: 'short' }))).status).toBe(400);
    expect((await post(device({ platform: 'watch' as DeviceInput['platform'] }))).status).toBe(400);
    expect((await post('nope')).status).toBe(400);
    repos.users.seed({ id: 'u_audit', role: 'auditor' });
    setTestUser({ userId: 'u_audit', role: 'auditor' });
    expect((await post(device())).status).toBe(403);
    expect(me.devices).toEqual([]);
  });
});

describe('GET /api/v1/me/reports', () => {
  test('own Named/Initials reports, newest first, through the public projection; anonymous ones are not linked', async () => {
    await fileReport(JANE.id);
    await fileReport(JANE.id, { reporterDisplay: 'initials' });
    await fileReport(JANE.id, { reporterDisplay: 'anonymous' });
    await fileReport(BOB.id);
    const res = await GET_MY_REPORTS(req('/reports'));
    expect(res.status).toBe(200);
    const { reports } = await res.json();
    expect(reports.map((r: { id: string }) => r.id)).toEqual(['rc_000002', 'rc_000001']);
    for (const r of reports) expect(PublicReportSchema.safeParse(r).success).toBe(true);
    expect(reports[0]).toMatchObject({ reporterDisplay: 'initials', reporterName: 'J.D.' });
    expect(reports[0].timeline).toHaveLength(1);
    expect(JSON.stringify(reports)).not.toMatch(FORBIDDEN);
  });
});

describe('GET /api/v1/me/export', () => {
  test('a JSON file of everything linked to the account, twice a day, then 429 with Retry-After', async () => {
    me.seedExtras(JANE.id, { email: 'jane@example.org' });
    await fileReport(JANE.id);
    await fileReport(JANE.id, { reporterDisplay: 'anonymous' });
    me.votes.push({ report_id: 'rc_000001', user_id: JANE.id, weight: 1, created_at: NOW });
    me.follows.push({ report_id: 'rc_000001', user_id: JANE.id });
    me.comments.push({ id: 'c_1', report_id: 'rc_000001', user_id: JANE.id, body: 'Worse after rain', created_at: NOW });
    await me.upsertDevice(JANE.id, device(), NOW);
    await me.createWatchArea(JANE.id, watch());

    const res = await GET_EXPORT(req('/export'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="rootcause-export-\d{4}-\d{2}-\d{2}\.json"$/);
    const body = await res.json();
    expect(body.format).toBe('rootcause-export/v1');
    expect(body.account).toMatchObject({ userId: JANE.id, email: 'jane@example.org', role: 'resident' });
    expect(body.watchAreas).toHaveLength(1);
    expect(body.reports.map((r: { id: string }) => r.id)).toEqual(['rc_000001']);
    expect(body.votes).toEqual([{ reportId: 'rc_000001', at: NOW }]);
    expect(body.follows).toEqual(['rc_000001']);
    expect(body.comments).toEqual([{ reportId: 'rc_000001', body: 'Worse after rain', at: NOW }]);
    expect(body.devices).toEqual([{ platform: 'ios', lastSeenAt: NOW }]);
    expect(JSON.stringify(body)).not.toMatch(FORBIDDEN);

    expect((await GET_EXPORT(req('/export'))).status).toBe(200);
    const limited = await GET_EXPORT(req('/export'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe(String(EXPORT_LIMIT.windowSec));
    expect((await limited.json()).error.code).toBe('rate_limited');
    setTestUser({ userId: BOB.id, role: 'resident' });
    expect((await GET_EXPORT(req('/export'))).status).toBe(200);
    setTestUser({ userId: JANE.id, role: 'resident' });
    now += EXPORT_LIMIT.windowSec * 1000 + 1;
    expect((await GET_EXPORT(req('/export'))).status).toBe(200);
  });
});

describe('POST /api/v1/me/apple-link', () => {
  const post = (body: unknown) => POST_APPLE_LINK(req('/apple-link', { method: 'POST', body }));
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fetch'));
  });

  afterEach(() => fetchSpy.mockRestore());

  test('400 without a code; 503 without the Apple server configuration', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ authorizationCode: '' })).status).toBe(400);
    const res = await post({ authorizationCode: 'c0de' });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('misconfigured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('exchanges the code at Apple, stores the refresh token sealed, maps Apple errors, and limits per account', async () => {
    const apple = await appleTestEnv();
    const restore = withEnv(apple.env);
    try {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r_refresh_123', id_token: 'i' }), { status: 200 }));
      const res = await post({ authorizationCode: 'c0de' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(APPLE.tokenUrl);
      const form = new URLSearchParams(String(init.body));
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('code')).toBe('c0de');
      expect(form.get('client_id')).toBe(APPLE.defaultClientId);
      const stored = (await me.getMe(JANE.id))?.apple_refresh_token ?? '';
      expect(stored.startsWith('v1.')).toBe(true);
      expect(stored).not.toContain('r_refresh_123');
      expect(await openToken(stored)).toBe('r_refresh_123');

      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
      const rejected = await post({ authorizationCode: 'expired' });
      expect(rejected.status).toBe(400);
      expect((await rejected.json()).error.message).toMatch(/Apple did not accept/);

      fetchSpy.mockRejectedValueOnce(new Error('apple down'));
      expect((await post({ authorizationCode: 'c0de' })).status).toBe(500);

      for (let i = 3; i < APPLE_LINK_LIMIT.perWindow; i++) {
        fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ refresh_token: `r_${i}` }), { status: 200 }));
        expect((await post({ authorizationCode: `c${i}` })).status).toBe(200);
      }
      const limited = await post({ authorizationCode: 'one-more' });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('Retry-After')).toBe(String(APPLE_LINK_LIMIT.windowSec));
    } finally {
      restore();
    }
  });
});
