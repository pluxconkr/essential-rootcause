/**
 * src/services/syncQueue.ts retry matrix with a mocked fetch (plan §9.2): 201 → sent, "My reports" link, cached
 * report and the reporter's own vote/follow · the photo goes first (POST /api/v1/photos) and its id rides on the
 * report · 429 with Retry-After → still queued and not retried before the window · 401 → needs_sign_in, or one retry
 * when the token provider refreshed · 422 → failed with the server's reason and never retried · a network error →
 * queued · a replay keeps the same clientDraftId · offline sends nothing · an incomplete draft fails with what is
 * missing · anonymous drafts leave no vote or follow · flush() runs oldest first and picks up parked drafts once
 * there is a session.
 */
import { buildDemoReports } from '@/domain/demo';
import type { AuthSession, Draft, PublicReport } from '@/domain/types';
import { setTokenProvider } from '@/services/auth';
import { RETRY, flush, nextAttemptAt, submitDraft } from '@/services/syncQueue';
import { actions, getState, hydrate, setState } from '@/store/appStore';

const SESSION: AuthSession = { userId: 'u_jane', role: 'resident', displayName: 'Jane Doe', email: null, provider: 'apple' };
const T0 = '2026-10-05T12:00:00.000Z';

function report(id: string, over: Partial<PublicReport> = {}): PublicReport {
  const { isDemo: _demo, ...base } = buildDemoReports('calm')[0];
  return { ...base, id, voteCount: 1, reporterDisplay: 'named', ...over };
}

function draft(id: string, over: Partial<Draft> = {}): Draft {
  return {
    id,
    photoUris: [],
    thumbUris: [],
    gps: { lat: 40.4862, lng: -74.4518, accuracyM: 8 },
    locationConfirmed: true,
    capturedAt: T0,
    form: { category: 'vegetation', subtype: 'root_heave', severityResident: 2, injuryFlag: 'no', reporterDisplay: 'named', lat: 40.4862, lng: -74.4518, accuracyM: 8, locationConfirmed: true, note: 'Lifted panel' },
    status: 'queued',
    failReason: null,
    reportId: null,
    updatedAt: T0,
    ...over,
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const failure = (status: number, code: string, message: string, headers: Record<string, string> = {}) => json(status, { error: { code, message } }, headers);

const fetchSpy = jest.spyOn(globalThis, 'fetch');
const call = (i: number) => fetchSpy.mock.calls[i] as unknown as [string, RequestInit];
const bodyOf = (i: number) => JSON.parse(call(i)[1].body as string) as Record<string, unknown>;

beforeEach(() => {
  hydrate();
  actions.resetAll();
  setState({ network: { online: true, type: 'wifi' }, session: SESSION });
  fetchSpy.mockReset();
});

afterEach(() => setTokenProvider(async () => null));
afterAll(() => fetchSpy.mockRestore());

test('201 → sent: the draft id is the clientDraftId; the report is linked, cached, voted and followed', async () => {
  const d = draft('d_sent_000001');
  actions.upsertDraft(d);
  fetchSpy.mockResolvedValueOnce(json(201, { report: report('rc_000001') }));
  const out = await submitDraft(d);
  expect(out.outcome).toBe('sent');
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(call(0)[0]).toMatch(/\/api\/v1\/reports$/);
  expect(call(0)[1].method).toBe('POST');
  expect(bodyOf(0)).toMatchObject({ clientDraftId: d.id, category: 'vegetation', subtype: 'root_heave', photoIds: [], note: 'Lifted panel', capturedAt: T0 });
  expect(getState().drafts[0]).toMatchObject({ status: 'sent', reportId: 'rc_000001', failReason: null });
  expect(getState().myReports[0]).toMatchObject({ reportId: 'rc_000001', draftId: d.id, anonymous: false });
  expect(getState().feed.some((r) => r.id === 'rc_000001')).toBe(true);
  expect(getState().votedIds).toContain('rc_000001');
  expect(getState().followedIds).toContain('rc_000001');
  expect(nextAttemptAt(d.id)).toBeNull();
});

test('the photo is uploaded first and its id rides on the report; the id is kept on the draft', async () => {
  const d = draft('d_photo_000001', { photoUris: ['file:///mock/document/drafts/d_photo_000001/full.jpg'], thumbUris: ['file:///mock/document/drafts/d_photo_000001/thumb.jpg'] });
  actions.upsertDraft(d);
  fetchSpy.mockResolvedValueOnce(json(201, { photoId: 'ph_000001', bytes: 1000, width: 1280, height: 960 })).mockResolvedValueOnce(json(201, { report: report('rc_000002') }));
  const out = await submitDraft(d);
  expect(out.outcome).toBe('sent');
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(call(0)[0]).toMatch(/\/api\/v1\/photos$/);
  expect(call(0)[1].body).toBeInstanceOf(Uint8Array);
  expect(String((call(0)[1].headers as Record<string, string>)['Content-Type'])).toMatch(/^multipart\/form-data; boundary=/);
  expect(new TextDecoder().decode(call(0)[1].body as Uint8Array)).toMatch(/name="photo"; filename="full.jpg"[\s\S]*name="thumb"; filename="thumb.jpg"/);
  expect(call(1)[0]).toMatch(/\/api\/v1\/reports$/);
  expect(bodyOf(1).photoIds).toEqual(['ph_000001']);
  expect(getState().drafts[0]).toMatchObject({ status: 'sent', photoIds: ['ph_000001'] });
});

test('a stale photo id (purged upload, restarted dev server) is forgotten and the phone\'s copy is uploaded again, once', async () => {
  const d = draft('d_stale_000001', { photoUris: ['file:///mock/document/drafts/d_stale_000001/full.jpg'], thumbUris: ['file:///mock/document/drafts/d_stale_000001/thumb.jpg'], photoIds: ['ph_000001'] });
  actions.upsertDraft(d);
  fetchSpy
    .mockResolvedValueOnce(failure(400, 'unknown_photo', 'Invalid request. photoIds: unknown photo or not uploaded by this account.'))
    .mockResolvedValueOnce(json(201, { photoId: 'ph_000002', bytes: 1000, width: 1280, height: 960 }))
    .mockResolvedValueOnce(json(201, { report: report('rc_000003') }));
  const out = await submitDraft(d);
  expect(out.outcome).toBe('sent');
  expect(fetchSpy).toHaveBeenCalledTimes(3);
  expect(call(0)[0]).toMatch(/\/api\/v1\/reports$/);
  expect(bodyOf(0).photoIds).toEqual(['ph_000001']);
  expect(call(1)[0]).toMatch(/\/api\/v1\/photos$/);
  expect(bodyOf(2).photoIds).toEqual(['ph_000002']);
  expect(getState().drafts[0]).toMatchObject({ status: 'sent', photoIds: ['ph_000002'] });
  // A second unknown_photo in the same submit is a real failure, not a loop.
  const e = draft('d_stale_000002', { photoUris: ['file:///mock/document/drafts/d_stale_000002/full.jpg'], photoIds: ['ph_000009'] });
  actions.upsertDraft(e);
  fetchSpy
    .mockResolvedValueOnce(failure(400, 'unknown_photo', 'unknown photo'))
    .mockResolvedValueOnce(json(201, { photoId: 'ph_000010', bytes: 1000, width: 1280, height: 960 }))
    .mockResolvedValueOnce(failure(400, 'unknown_photo', 'unknown photo'));
  expect((await submitDraft(e)).outcome).toBe('failed');
  expect(fetchSpy).toHaveBeenCalledTimes(6);
});

test('429 with Retry-After → still queued; flush() does not retry it before the window', async () => {
  const d = draft('d_limit_000001');
  actions.upsertDraft(d);
  fetchSpy.mockResolvedValueOnce(failure(429, 'rate_limited', 'You have filed many reports this hour.', { 'retry-after': '120' }));
  const before = Date.now();
  const out = await submitDraft(d);
  expect(out).toEqual({ outcome: 'queued', reason: 'You have filed many reports this hour.' });
  expect(getState().drafts[0]).toMatchObject({ status: 'queued', failReason: null, reportId: null });
  const at = nextAttemptAt(d.id);
  expect(at).not.toBeNull();
  expect(at! - before).toBeGreaterThanOrEqual(120_000);
  expect(at! - before).toBeLessThan(125_000);
  fetchSpy.mockClear();
  expect(await flush()).toEqual({ sent: 0, failed: 0, skipped: 1 });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('a network error → queued with the default backoff', async () => {
  const d = draft('d_net_000001');
  actions.upsertDraft(d);
  fetchSpy.mockRejectedValueOnce(new TypeError('Network request failed'));
  const before = Date.now();
  expect((await submitDraft(d)).outcome).toBe('queued');
  expect(getState().drafts[0].status).toBe('queued');
  expect(nextAttemptAt(d.id)! - before).toBeGreaterThanOrEqual(RETRY.backoffMs);
});

test('401 → needs_sign_in when there is no token; one retry when the provider refreshed', async () => {
  const d = draft('d_auth_000001');
  actions.upsertDraft(d);
  fetchSpy.mockResolvedValueOnce(failure(401, 'unauthenticated', 'Your session has expired.'));
  expect(await submitDraft(d)).toEqual({ outcome: 'needs_sign_in' });
  expect(getState().drafts[0].status).toBe('needs_sign_in');
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  setTokenProvider(async () => 'fresh-token');
  const e = draft('d_auth_000002');
  actions.upsertDraft(e);
  fetchSpy.mockClear();
  fetchSpy.mockResolvedValueOnce(failure(401, 'unauthenticated', 'expired')).mockResolvedValueOnce(json(201, { report: report('rc_000003') }));
  expect((await submitDraft(e)).outcome).toBe('sent');
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect((call(1)[1].headers as Record<string, string>).Authorization).toBe('Bearer fresh-token');
  expect(bodyOf(0).clientDraftId).toBe(e.id);
  expect(bodyOf(1).clientDraftId).toBe(e.id);
});

test('422 → failed with the server’s reason; flush() never retries a failed draft', async () => {
  const d = draft('d_bad_000001');
  actions.upsertDraft(d);
  fetchSpy.mockResolvedValueOnce(failure(422, 'invalid_transition', 'Sub-type does not match the category.'));
  expect(await submitDraft(d)).toEqual({ outcome: 'failed', reason: 'Sub-type does not match the category.' });
  expect(getState().drafts[0]).toMatchObject({ status: 'failed', failReason: 'Sub-type does not match the category.' });
  fetchSpy.mockClear();
  expect(await flush()).toEqual({ sent: 0, failed: 0, skipped: 0 });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('a replay after a 5xx carries the same clientDraftId and accepts the 200 the server answers with', async () => {
  const d = draft('d_replay_000001');
  actions.upsertDraft(d);
  fetchSpy.mockResolvedValueOnce(failure(503, 'misconfigured', 'Try again later.'));
  expect((await submitDraft(d)).outcome).toBe('queued');
  fetchSpy.mockResolvedValueOnce(json(200, { report: report('rc_000004') }));
  expect((await submitDraft(getState().drafts[0])).outcome).toBe('sent');
  expect(bodyOf(0).clientDraftId).toBe(d.id);
  expect(bodyOf(1).clientDraftId).toBe(d.id);
  expect(getState().drafts[0]).toMatchObject({ status: 'sent', reportId: 'rc_000004' });
});

test('offline: flush() sends nothing and reports the drafts it skipped', async () => {
  actions.upsertDraft(draft('d_off_000001'));
  actions.upsertDraft(draft('d_off_000002'));
  setState({ network: { online: false, type: 'NONE' } });
  expect(await flush()).toEqual({ sent: 0, failed: 0, skipped: 2 });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('an incomplete draft fails with what is missing, without a request', async () => {
  const d = draft('d_empty_000001', { form: {} });
  actions.upsertDraft(d);
  const out = await submitDraft(d);
  expect(out.outcome).toBe('failed');
  expect(out.outcome === 'failed' && out.reason).toMatch(/missing: .*category/);
  expect(getState().drafts[0].status).toBe('failed');
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('an anonymous draft is linked locally but leaves no vote or follow on this phone', async () => {
  const d = draft('d_anon_000001', { form: { ...draft('x').form, reporterDisplay: 'anonymous' } });
  actions.upsertDraft(d);
  fetchSpy.mockResolvedValueOnce(json(201, { report: report('rc_000005', { reporterDisplay: 'anonymous', reporterName: null }) }));
  expect((await submitDraft(d)).outcome).toBe('sent');
  expect(getState().myReports[0]).toMatchObject({ reportId: 'rc_000005', anonymous: true });
  expect(getState().votedIds).not.toContain('rc_000005');
  expect(getState().followedIds).not.toContain('rc_000005');
});

test('flush() goes oldest first and picks up a parked needs_sign_in draft once there is a session', async () => {
  actions.upsertDraft(draft('d_second_000001', { capturedAt: '2026-10-05T13:00:00.000Z' }));
  actions.upsertDraft(draft('d_first_000001', { capturedAt: '2026-10-05T11:00:00.000Z', status: 'needs_sign_in' }));
  actions.upsertDraft(draft('d_draft_000001', { status: 'draft' }));
  fetchSpy.mockResolvedValueOnce(json(201, { report: report('rc_000006') })).mockResolvedValueOnce(json(201, { report: report('rc_000007') }));
  expect(await flush()).toEqual({ sent: 2, failed: 0, skipped: 0 });
  expect(bodyOf(0).clientDraftId).toBe('d_first_000001');
  expect(bodyOf(1).clientDraftId).toBe('d_second_000001');
  expect(getState().drafts.find((x) => x.id === 'd_draft_000001')?.status).toBe('draft');
});
