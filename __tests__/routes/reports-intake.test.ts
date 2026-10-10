/**
 * Intake through POST /api/v1/reports with photos, and POST /api/v1/reports/[id]/photos, against the memory repos
 * (plan §4 flows 2 and 4, §3.4/§23.D unlinkability, AC19): a Named report attaches this account's pending uploads and
 * keeps the uploader; an Anonymous report has reporter_id NULL, uploader_id NULL on its photos, a creation event with
 * actor_type reporter_anonymous and no actor, and no follow or vote rows — only reporter_vote_weight; someone else's
 * or an unknown photo is a 400; a replay with the same photoIds is still a 200; the note comes back as `summary`.
 * Attaching to an existing report: phase `before` is a vote (once per account), `after` needs an inspector, closed
 * reports refuse evidence (422), and the usual 401/400/403/404/409/429.
 */
import { POST as ATTACH } from '@/app/api/v1/reports/[id]/photos+api';
import { POST as CREATE } from '@/app/api/v1/reports+api';
import { communityTerm } from '@/domain/score';
import { PublicReportSchema, type CreateReportInput } from '@/domain/types';
import { setTestUser } from '@/server/auth';
import { setLogSink } from '@/server/log';
import { MemoryRateLimiter, setRateLimiter } from '@/server/ratelimit';
import { createMemoryRepos, type MemoryRepos } from '@/server/repos/memory';
import { setRepos } from '@/server/repos/types';

const reportsUrl = 'http://localhost/api/v1/reports';
const JANE = { id: 'u_jane', display_name: 'Jane Doe' };
const BOB = { id: 'u_bob', display_name: 'Bob Ray' };
const NOW = '2026-10-05T12:00:00.000Z';
const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

const input = (over: Partial<CreateReportInput> = {}): CreateReportInput => ({
  clientDraftId: 'd_m2k9x1a3_7f3kq',
  category: 'vegetation',
  subtype: 'root_heave',
  severityResident: 2,
  injuryFlag: 'no',
  reporterDisplay: 'named',
  lat: 40.4862,
  lng: -74.4518,
  accuracyM: 8,
  locationConfirmed: true,
  addressText: '12 Somerset St',
  note: 'Lifted panel by the bus stop',
  photoIds: [],
  capturedAt: NOW,
  ...over,
});

const create = (body: unknown) => CREATE(new Request(reportsUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const attach = (id: string, body: unknown) => ATTACH(new Request(`${reportsUrl}/${id}/photos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }), { id });

let repos: MemoryRepos;
let now: number;

const putPhoto = async (uploaderId: string) => (await repos.photos.put({ uploaderId, full: bytes, thumb: bytes, width: 640, height: 480, now: NOW })).id;

beforeAll(() => setLogSink(() => {}));
afterAll(() => {
  setLogSink(null);
  setRepos(null);
  setRateLimiter(null);
  setTestUser(undefined);
});

beforeEach(() => {
  repos = createMemoryRepos();
  repos.users.seed(JANE);
  repos.users.seed(BOB);
  setRepos(repos);
  now = Date.parse(NOW);
  setRateLimiter(new MemoryRateLimiter(() => now));
  setTestUser({ userId: JANE.id, role: 'resident' });
});

describe('POST /api/v1/reports with photos', () => {
  test('a Named report attaches this account’s pending uploads, keeps the uploader, writes vote and follow rows, and emits the note as summary', async () => {
    const ph1 = await putPhoto(JANE.id);
    const ph2 = await putPhoto(JANE.id);
    const res = await create(input({ photoIds: [ph1, ph2] }));
    expect(res.status).toBe(201);
    const { report } = await res.json();
    expect(PublicReportSchema.safeParse(report).success).toBe(true);
    expect(report.summary).toBe('Lifted panel by the bus stop');
    // staff_only until triage: the public projection shows no photo yet (plan §12).
    expect(report.photos).toEqual([]);
    const row = repos.reports.rows[0];
    expect(row.photos.map((p) => p.id)).toEqual([ph1, ph2]);
    expect(row.photos.every((p) => p.uploader_id === JANE.id && p.visibility === 'staff_only' && p.phase === 'before')).toBe(true);
    expect(repos.photos.rows.map((p) => p.report_id)).toEqual(['rc_000001', 'rc_000001']);
    expect(row.events[0]).toMatchObject({ kind: 'created', actor_type: 'resident', actor_id: JANE.id });
    expect([...repos.reports.voteRows.get('rc_000001')!]).toEqual([[JANE.id, 1]]);
    expect([...repos.reports.followRows.get('rc_000001')!]).toEqual([JANE.id]);
  });

  test('AC19: an Anonymous report is unlinkable — no reporter, no uploader, no actor, no follow or vote rows', async () => {
    const ph = await putPhoto(JANE.id);
    const res = await create(input({ reporterDisplay: 'anonymous', photoIds: [ph] }));
    expect(res.status).toBe(201);
    const { report } = await res.json();
    expect(report).toMatchObject({ reporterDisplay: 'anonymous', reporterName: null, voteCount: 1, summary: 'Lifted panel by the bus stop' });
    const row = repos.reports.rows[0];
    expect(row.reporter_id).toBeNull();
    expect(row.reporter_vote_weight).toBe(1);
    expect(row.photos).toHaveLength(1);
    expect(row.photos[0].uploader_id).toBeNull();
    expect(repos.photos.rows[0]).toMatchObject({ report_id: 'rc_000001', uploader_id: null });
    expect(row.events[0]).toMatchObject({ kind: 'created', actor_type: 'reporter_anonymous', actor_id: null });
    expect(repos.reports.voteRows.has('rc_000001')).toBe(false);
    expect(repos.reports.followRows.has('rc_000001')).toBe(false);
    expect(JSON.stringify(row)).not.toContain(JANE.id);
    expect(JSON.stringify(report)).not.toContain(JANE.id);
  });

  test('400 for an unknown photo or another account’s pending photo; nothing is created', async () => {
    const bobs = await putPhoto(BOB.id);
    const unknown = await create(input({ photoIds: ['ph_999999'] }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.message).toMatch(/photoIds/);
    expect((await create(input({ photoIds: [bobs] }))).status).toBe(400);
    expect(repos.reports.rows).toHaveLength(0);
    expect(repos.photos.rows[0].report_id).toBeNull();
  });

  test('a replay with the same clientDraftId and the (now attached) photoIds is a 200 with the original report', async () => {
    const ph = await putPhoto(JANE.id);
    const first = await (await create(input({ reporterDisplay: 'anonymous', photoIds: [ph] }))).json();
    const res = await create(input({ reporterDisplay: 'anonymous', photoIds: [ph] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(first);
    expect(repos.reports.rows).toHaveLength(1);
    expect(repos.photos.rows).toHaveLength(1);
  });
});

describe('POST /api/v1/reports/[id]/photos', () => {
  let reportId: string;

  beforeEach(async () => {
    setTestUser({ userId: BOB.id, role: 'resident' });
    const { report } = await (await create(input({ clientDraftId: 'd_bobs_report_abcdef' }))).json();
    reportId = report.id;
    setTestUser({ userId: JANE.id, role: 'resident' });
  });

  test('401 without a session, 400 for a bad body, 404 for an unknown photo or report, 403 for another account’s photo, 409 when already attached', async () => {
    const ph = await putPhoto(JANE.id);
    setTestUser(null);
    expect((await attach(reportId, { photoId: ph })).status).toBe(401);
    setTestUser({ userId: JANE.id, role: 'resident' });
    expect((await attach(reportId, '{nope')).status).toBe(400);
    expect((await attach(reportId, { photoId: ph, phase: 'during' })).status).toBe(400);
    expect((await attach(reportId, { photoId: 'ph_999999' })).status).toBe(404);
    expect((await attach('rc_999999', { photoId: ph })).status).toBe(404);
    expect((await attach('', { photoId: ph })).status).toBe(404);
    const bobs = await putPhoto(BOB.id);
    expect((await attach(reportId, { photoId: bobs })).status).toBe(403);
    expect((await attach(reportId, { photoId: ph })).status).toBe(201);
    const again = await attach(reportId, { photoId: ph });
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe('conflict');
  });

  test('`before` attaches the photo and counts as the account’s vote exactly once; the score moves with the community term', async () => {
    const scoreBefore = repos.reports.rows[0].score;
    const ph1 = await putPhoto(JANE.id);
    const res = await attach(reportId, { photoId: ph1, phase: 'before' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.voted).toBe(true);
    expect(PublicReportSchema.safeParse(body.report).success).toBe(true);
    expect(body.report.voteCount).toBe(2);
    expect(JSON.stringify(body)).not.toMatch(/reporter_id|uploader_id|u_jane|u_bob/);
    const row = repos.reports.rows[0];
    expect(row.photos.map((p) => p.id)).toEqual([ph1]);
    expect(row.photos[0]).toMatchObject({ uploader_id: JANE.id, phase: 'before', visibility: 'staff_only' });
    expect(repos.photos.rows.find((p) => p.id === ph1)).toMatchObject({ report_id: reportId, uploader_id: JANE.id });
    expect([...repos.reports.voteRows.get(reportId)!.keys()]).toEqual([BOB.id, JANE.id]);
    expect(row.score_terms.community).toBeCloseTo(communityTerm(2, 0), 6);
    expect(row.score).toBeGreaterThan(scoreBefore);
    // Bob's own vote and follow are untouched; Jane does not follow by attaching.
    expect([...repos.reports.followRows.get(reportId)!]).toEqual([BOB.id]);

    // A second photo from the same account is attached but adds no vote.
    const ph2 = await putPhoto(JANE.id);
    const second = await (await attach(reportId, { photoId: ph2 })).json();
    expect(second.voted).toBe(false);
    expect(second.report.voteCount).toBe(2);
    expect(repos.reports.rows[0].photos).toHaveLength(2);
  });

  test('`after` needs an inspector and records no vote; a closed report refuses `before` with 422', async () => {
    const ph = await putPhoto(JANE.id);
    const denied = await attach(reportId, { photoId: ph, phase: 'after' });
    expect(denied.status).toBe(403);
    repos.users.seed({ id: 'u_insp', role: 'inspector', display_name: 'I. Spector' });
    setTestUser({ userId: 'u_insp', role: 'inspector' });
    const insp = await putPhoto('u_insp');
    const res = await attach(reportId, { photoId: insp, phase: 'after' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.voted).toBe(false);
    expect(body.report.voteCount).toBe(1);
    expect(repos.reports.rows[0].photos[0]).toMatchObject({ id: insp, phase: 'after' });

    repos.reports.rows[0].status = 'completed';
    setTestUser({ userId: JANE.id, role: 'resident' });
    const closed = await attach(reportId, { photoId: ph });
    expect(closed.status).toBe(422);
    expect((await closed.json()).error.code).toBe('invalid_transition');
    expect(repos.photos.rows.find((p) => p.id === ph)!.report_id).toBeNull();
  });

  test('429 after the hourly attach limit, with Retry-After', async () => {
    for (let i = 0; i < 20; i++) expect((await attach(reportId, { photoId: await putPhoto(JANE.id) })).status).toBe(201);
    const res = await attach(reportId, { photoId: await putPhoto(JANE.id) });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
  });
});
