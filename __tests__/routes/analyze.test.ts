/**
 * POST /api/v1/vision/analyze with the memory repos (plan §7, §3.6, §23.I): 401 without a session · 400 for a bad
 * body · 404 for an unknown photo · 403 for another account's photo · 200 with `proposals: null, reason: 'disabled'`
 * in M1 (the src/server/vision.ts seam calls no model) and the open reports within the duplicate radius — of the
 * hinted sub-type, or of every category without a hint — as DuplicateCandidate rows with title, votes and days open ·
 * closed reports are never candidates · 429 after ANALYZE_LIMIT.perWindow analyses a day, per account.
 */
import { POST as CREATE_REPORT } from '@/app/api/v1/reports+api';
import { ANALYZE_LIMIT, MAX_DUPLICATES, POST } from '@/app/api/v1/vision/analyze+api';
import { PILOT } from '@/domain/pilot';
import { AnalyzeResponseSchema, DuplicateCandidateSchema, type CreateReportInput } from '@/domain/types';
import { setTestUser } from '@/server/auth';
import { setLogSink } from '@/server/log';
import { MemoryRateLimiter, setRateLimiter } from '@/server/ratelimit';
import { createMemoryRepos, type MemoryRepos } from '@/server/repos/memory';
import { setRepos } from '@/server/repos/types';

const url = 'http://localhost/api/v1/vision/analyze';
const JANE = { id: 'u_jane', display_name: 'Jane Doe' };
const BOB = { id: 'u_bob', display_name: 'Bob Ray' };
const NOW = '2026-10-05T12:00:00.000Z';
const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

const post = (body: unknown) => POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }));

const report = (over: Partial<CreateReportInput> = {}): CreateReportInput => ({
  clientDraftId: `d_${Math.random().toString(36).slice(2, 10)}_abcdef`,
  category: 'vegetation',
  subtype: 'root_heave',
  severityResident: 2,
  injuryFlag: 'no',
  reporterDisplay: 'named',
  lat: PILOT.center.lat,
  lng: PILOT.center.lng,
  accuracyM: 8,
  locationConfirmed: true,
  addressText: '12 Somerset St',
  photoIds: [],
  capturedAt: NOW,
  ...over,
});

let repos: MemoryRepos;
let now: number;
let photoId: string;

beforeAll(() => setLogSink(() => {}));
afterAll(() => {
  setLogSink(null);
  setRepos(null);
  setRateLimiter(null);
  setTestUser(undefined);
});

beforeEach(async () => {
  repos = createMemoryRepos();
  repos.users.seed(JANE);
  repos.users.seed(BOB);
  setRepos(repos);
  now = Date.parse(NOW);
  setRateLimiter(new MemoryRateLimiter(() => now));
  setTestUser({ userId: JANE.id, role: 'resident' });
  photoId = (await repos.photos.put({ uploaderId: JANE.id, full: bytes, thumb: bytes, width: 640, height: 480, now: NOW })).id;
});

const input = (over: Record<string, unknown> = {}) => ({ photoId, lat: PILOT.center.lat, lng: PILOT.center.lng, ...over });

test('401 without a session, 400 for a bad body, 404 for an unknown photo, 403 for another account’s photo', async () => {
  setTestUser(null);
  expect((await post(input())).status).toBe(401);
  setTestUser({ userId: JANE.id, role: 'resident' });
  expect((await post('{nope')).status).toBe(400);
  expect((await post(input({ lat: 91 }))).status).toBe(400);
  expect((await post(input({ subtypeHint: 'lava' }))).status).toBe(400);
  expect((await post({ lat: 1, lng: 2 })).status).toBe(400);
  const missing = await post(input({ photoId: 'ph_nope' }));
  expect(missing.status).toBe(404);
  expect((await missing.json()).error.code).toBe('not_found');
  setTestUser({ userId: BOB.id, role: 'resident' });
  const other = await post(input());
  expect(other.status).toBe(403);
  expect((await other.json()).error.code).toBe('forbidden');
});

test('200: the model is off in M1, and nearby open reports come back as duplicate candidates', async () => {
  // Seed as Bob so Jane's analysis sees other people's reports: a root heave at the centre, a pothole 15 m away, a lamp 300 m away.
  setTestUser({ userId: BOB.id, role: 'resident' });
  const seed = (body: CreateReportInput) => CREATE_REPORT(new Request('http://localhost/api/v1/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  expect((await seed(report())).status).toBe(201);
  expect((await seed(report({ category: 'roadway', subtype: 'pothole', lat: PILOT.center.lat + 0.00013 }))).status).toBe(201);
  expect((await seed(report({ category: 'lighting', subtype: 'lamp_out', lat: PILOT.center.lat + 0.0027 }))).status).toBe(201);
  setTestUser({ userId: JANE.id, role: 'resident' });

  const hinted = await post(input({ subtypeHint: 'root_heave' }));
  expect(hinted.status).toBe(200);
  const a = await hinted.json();
  expect(AnalyzeResponseSchema.safeParse(a).success).toBe(true);
  expect(a).toMatchObject({ proposals: null, reason: 'disabled', model: null });
  expect(a.duplicates.map((d: { id: string }) => d.id)).toEqual(['rc_000001']);
  expect(DuplicateCandidateSchema.safeParse(a.duplicates[0]).success).toBe(true);
  expect(a.duplicates[0]).toMatchObject({ title: 'Tree root heaving sidewalk (trip hazard)', subtype: 'root_heave', status: 'new', voteCount: 1, daysOpen: 0 });
  expect(a.duplicates[0].distanceM).toBeLessThan(1);

  const any = await (await post(input())).json();
  expect(any.duplicates.map((d: { id: string }) => d.id)).toEqual(['rc_000001', 'rc_000002']);
  expect(any.duplicates[1].distanceM).toBeGreaterThan(10);
  expect(any.duplicates[1].distanceM).toBeLessThan(25);
  expect(any.duplicates.length).toBeLessThanOrEqual(MAX_DUPLICATES);
  expect(JSON.stringify(any)).not.toMatch(/reporter_id|uploader_id|u_bob|client_draft_id/);

  // A closed report is not a duplicate candidate; a candidate from the far lamp never appears.
  repos.reports.rows[0].status = 'completed';
  const after = await (await post(input())).json();
  expect(after.duplicates.map((d: { id: string }) => d.id)).toEqual(['rc_000002']);
});

test('429 after ANALYZE_LIMIT.perWindow analyses in a day, per account, with Retry-After', async () => {
  for (let i = 0; i < ANALYZE_LIMIT.perWindow; i++) expect((await post(input())).status).toBe(200);
  const res = await post(input());
  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe(String(ANALYZE_LIMIT.windowSec));
  expect((await res.json()).error.code).toBe('rate_limited');
  now += ANALYZE_LIMIT.windowSec * 1000 + 1;
  expect((await post(input())).status).toBe(200);
});
