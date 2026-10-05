/**
 * /api/v1/reports and /api/v1/reports/[id] with the memory repos, a test session and the memory rate limiter
 * (plan §14 route tests): 400 invalid · 401 no session · 403 auditor · 201 create · 200 idempotent replay with the
 * same id · 429 after CREATE_LIMIT.perWindow creates in an hour · public projection with no forbidden field ·
 * list filters, sort and cursor · 404 · PATCH 501.
 */
import { CREATE_LIMIT, GET, POST } from '@/app/api/v1/reports+api';
import { GET as GET_ONE, PATCH } from '@/app/api/v1/reports/[id]+api';
import { distanceM } from '@/domain/geo';
import { PublicReportListSchema, PublicReportSchema, type CreateReportInput } from '@/domain/types';
import { setTestUser } from '@/server/auth';
import { setLogSink } from '@/server/log';
import { MemoryRateLimiter, setRateLimiter } from '@/server/ratelimit';
import { createMemoryRepos, type MemoryRepos } from '@/server/repos/memory';
import { setRepos } from '@/server/repos/types';

const url = 'http://localhost/api/v1/reports';
const FORBIDDEN = /home_geom|phone|install_id|internal|reporter_id|uploader_id|client_draft_id|clientDraftId|storage_key|thumb_key|watch_area|email/;
const JANE = { id: 'u_jane', display_name: 'Jane Doe' };

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
  capturedAt: '2026-10-05T12:00:00.000Z',
  ...over,
});

const post = (body: unknown, headers: Record<string, string> = {}) => POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
const list = (query = '') => GET(new Request(`${url}${query}`));

let repos: MemoryRepos;
let now: number;
let limiter: MemoryRateLimiter;

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
  setRepos(repos);
  now = Date.parse('2026-10-05T12:00:00.000Z');
  limiter = new MemoryRateLimiter(() => now);
  setRateLimiter(limiter);
  setTestUser({ userId: JANE.id, role: 'resident' });
});

describe('POST /api/v1/reports', () => {
  test('401 without a session (test override and the real bearer path)', async () => {
    setTestUser(null);
    expect((await post(input())).status).toBe(401);
    setTestUser(undefined);
    const res = await post(input());
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
    expect(repos.reports.rows).toHaveLength(0);
  });

  test('400 for a non-JSON body, a schema failure and a sub-type that is not in the category', async () => {
    expect((await post('{not json')).status).toBe(400);
    const res = await post({ ...input(), severityResident: 9 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toMatch(/severityResident/);
    expect((await post({ ...input(), clientDraftId: 'short' })).status).toBe(400);
    expect((await post({ ...input(), lat: 91 })).status).toBe(400);
    expect((await post(input({ category: 'roadway', subtype: 'root_heave' }))).status).toBe(400);
    expect(repos.reports.rows).toHaveLength(0);
  });

  test('403 for an auditor: writes are rejected everywhere', async () => {
    repos.users.seed({ id: 'u_audit', role: 'auditor', display_name: 'A. Uditor' });
    setTestUser({ userId: 'u_audit', role: 'auditor' });
    const res = await post(input());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
  });

  test('201 creates a report and answers with the public projection only', async () => {
    const res = await post(input(), { 'x-request-id': 'req-1' });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-request-id')).toBe('req-1');
    const { report } = await res.json();
    expect(PublicReportSchema.safeParse(report).success).toBe(true);
    expect(report.id).toBe('rc_000001');
    expect(report.status).toBe('new');
    expect(report.title).toBe('Tree root heaving sidewalk (trip hazard)');
    expect(report.severity).toBe(2);
    expect(report.severityConfirmed).toBe(false);
    expect(report.emergencyRequested).toBe(false);
    expect(report.voteCount).toBe(1);
    expect(report.reporterDisplay).toBe('named');
    expect(report.reporterName).toBe('Jane Doe');
    expect(report.stormSensitivity).toEqual(['rain', 'freeze']);
    expect(report.addressText).toBe('12 Somerset St');
    expect(report.addressConfidence).toBe('exact');
    expect(report.timeline).toHaveLength(1);
    expect(report.timeline[0]).toMatchObject({ kind: 'created', fromStatus: null, toStatus: 'new', note: 'Lifted panel by the bus stop' });
    expect(report.photos).toEqual([]);
    expect(JSON.stringify(report)).not.toMatch(FORBIDDEN);
    // Reporter-linked: the public point is snapped and jittered, never the precise point.
    expect(report.lat).not.toBe(40.4862);
    expect(report.lng).not.toBe(-74.4518);
    expect(distanceM({ lat: report.lat, lng: report.lng }, { lat: 40.4862, lng: -74.4518 })).toBeLessThan(120);
    expect(repos.reports.rows[0].reporter_id).toBe(JANE.id);
  });

  test('200 replays the same clientDraftId with the same id and body', async () => {
    const first = await (await post(input())).json();
    const res = await post(input({ note: 'changed on retry' }));
    expect(res.status).toBe(200);
    const second = await res.json();
    expect(second.report.id).toBe(first.report.id);
    expect(second).toEqual(first);
    expect(repos.reports.rows).toHaveLength(1);
  });

  test('429 after CREATE_LIMIT.perWindow creates in an hour, per account, with Retry-After; the window slides', async () => {
    for (let i = 0; i < CREATE_LIMIT.perWindow; i++) expect((await post(input({ clientDraftId: `d_draft_${i}_abcdef` }))).status).toBe(201);
    const res = await post(input({ clientDraftId: 'd_draft_over_abcdef' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(CREATE_LIMIT.windowSec));
    expect((await res.json()).error.code).toBe('rate_limited');
    repos.users.seed({ id: 'u_other', display_name: 'Other' });
    setTestUser({ userId: 'u_other', role: 'resident' });
    expect((await post(input({ clientDraftId: 'd_draft_other_abcdef' }))).status).toBe(201);
    setTestUser({ userId: JANE.id, role: 'resident' });
    now += CREATE_LIMIT.windowSec * 1000 + 1;
    expect((await post(input({ clientDraftId: 'd_draft_later_abcdef' }))).status).toBe(201);
  });

  test('anonymous reports carry no reporter link and keep the precise point', async () => {
    const res = await post(input({ reporterDisplay: 'anonymous' }));
    expect(res.status).toBe(201);
    const { report } = await res.json();
    expect(report.reporterDisplay).toBe('anonymous');
    expect(report.reporterName).toBeNull();
    expect(report.lat).toBe(40.4862);
    expect(report.lng).toBe(-74.4518);
    expect(repos.reports.rows[0].reporter_id).toBeNull();
    expect(repos.reports.rows[0].events[0].actor_id).toBeNull();
  });

  test('initials and the emergency band: band 4 is requested, shown as 3 until confirmed', async () => {
    const { report } = await (await post(input({ reporterDisplay: 'initials', severityResident: 4 }))).json();
    expect(report.reporterName).toBe('J.D.');
    expect(report.emergencyRequested).toBe(true);
    expect(report.severity).toBe(3);
  });

  test('a second report of the same category within 25 m becomes a cluster candidate', async () => {
    await post(input());
    await post(input({ clientDraftId: 'd_second_abcdef', subtype: 'hanging_limb', lat: 40.48625, lng: -74.45185 }));
    await post(input({ clientDraftId: 'd_far_abcdef', lat: 40.49, lng: -74.46 }));
    expect(repos.reports.rows[1].cluster_candidate).toBe('rc_000001');
    expect(repos.reports.rows[2].cluster_candidate).toBeNull();
  });
});

describe('GET /api/v1/reports', () => {
  beforeEach(async () => {
    await post(input({ clientDraftId: 'd_veg_abcdef' }));
    await post(input({ clientDraftId: 'd_road_abcdef', category: 'roadway', subtype: 'pothole', lat: 40.49, lng: -74.44 }));
    await post(input({ clientDraftId: 'd_light_abcdef', category: 'lighting', subtype: 'lamp_out', lat: 40.5, lng: -74.43, reporterDisplay: 'anonymous' }));
  });

  test('lists public projections, newest first when asked, without timelines', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(PublicReportListSchema.safeParse(body).success).toBe(true);
    expect(body.reports).toHaveLength(3);
    expect(body.nextCursor).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(FORBIDDEN);
    expect(body.reports.every((r: { timeline: unknown[] }) => r.timeline.length === 0)).toBe(true);
    const newest = await (await list('?sort=newest')).json();
    expect(newest.reports.map((r: { id: string }) => r.id)).toEqual(['rc_000003', 'rc_000002', 'rc_000001']);
  });

  test('filters by category, status and bbox', async () => {
    expect((await (await list('?cat=roadway')).json()).reports.map((r: { id: string }) => r.id)).toEqual(['rc_000002']);
    expect((await (await list('?status=completed')).json()).reports).toEqual([]);
    expect((await (await list('?bbox=-74.46,40.48,-74.435,40.495')).json()).reports.map((r: { id: string }) => r.id).sort()).toEqual(['rc_000001', 'rc_000002']);
  });

  test('400 for a bad bbox, category, status, sort or limit', async () => {
    expect((await list('?bbox=1,2,3')).status).toBe(400);
    expect((await list('?bbox=-74,41,-75,40')).status).toBe(400);
    expect((await list('?cat=lava')).status).toBe(400);
    expect((await list('?status=bogus')).status).toBe(400);
    expect((await list('?sort=random')).status).toBe(400);
    expect((await list('?limit=0')).status).toBe(400);
    expect((await list('?limit=abc')).status).toBe(400);
  });

  test('pages with an opaque cursor', async () => {
    const first = await (await list('?sort=newest&limit=2')).json();
    expect(first.reports).toHaveLength(2);
    expect(first.nextCursor).toBe('rc_000002');
    const second = await (await list(`?sort=newest&limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.reports.map((r: { id: string }) => r.id)).toEqual(['rc_000001']);
    expect(second.nextCursor).toBeNull();
  });
});

describe('/api/v1/reports/[id]', () => {
  test('GET returns the public projection with its timeline, 404 when unknown', async () => {
    await post(input());
    const res = await GET_ONE(new Request(`${url}/rc_000001`), { id: 'rc_000001' });
    expect(res.status).toBe(200);
    const { report } = await res.json();
    expect(PublicReportSchema.safeParse(report).success).toBe(true);
    expect(report.id).toBe('rc_000001');
    expect(report.timeline).toHaveLength(1);
    expect(JSON.stringify(report)).not.toMatch(FORBIDDEN);
    expect((await GET_ONE(new Request(`${url}/nope`), { id: 'nope' })).status).toBe(404);
    expect((await GET_ONE(new Request(`${url}/`), {})).status).toBe(404);
  });

  test('PATCH is 501 until M2', async () => {
    const res = await PATCH(new Request(`${url}/rc_000001`, { method: 'PATCH', body: '{}' }), { id: 'rc_000001' });
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe('not_implemented');
  });
});
