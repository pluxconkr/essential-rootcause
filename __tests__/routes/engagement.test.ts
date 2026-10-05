/**
 * Votes, comments, follow and flag routes against the memory repos (plan §14, §7; spec §4.3; AC8, AC22): 401 without
 * a session on every write · vote 201 then 409 · weight 0.6 for a new account or no home area, 1.0 otherwise ·
 * unverified_geo beyond 1.5 km · 25 and 100 votes write flags + events once · DELETE is idempotent and rescored ·
 * 60/h limit · comments: filter rejects URLs and profanity, internal notes need an inspector, author display never
 * carries an email · follow idempotent · flags 10/d · the public projection reflects the counters.
 */
import { POST as FLAG_COMMENT } from '@/app/api/v1/comments/[id]/flag+api';
import { GET as GET_REPORT } from '@/app/api/v1/reports/[id]+api';
import { COMMENT_LIMIT, GET as GET_COMMENTS, POST as POST_COMMENT, commentAuthorDisplay } from '@/app/api/v1/reports/[id]/comments+api';
import { POST as FLAG_REPORT } from '@/app/api/v1/reports/[id]/flag+api';
import { DELETE as UNFOLLOW, POST as FOLLOW } from '@/app/api/v1/reports/[id]/follow+api';
import { DELETE as UNVOTE, POST as VOTE, VOTE_LIMIT } from '@/app/api/v1/reports/[id]/votes+api';
import { communityTerm, DEFAULT_WEIGHTS, scoreFromTerms } from '@/domain/score';
import { CommentsResponseSchema, VoteResponseSchema, type CreateReportInput } from '@/domain/types';
import { VOTE_THRESHOLDS } from '@/domain/votes';
import { setTestUser } from '@/server/auth';
import { FLAG_LIMIT } from '@/server/flags';
import { setLogSink } from '@/server/log';
import { MemoryRateLimiter, setRateLimiter } from '@/server/ratelimit';
import { setEngagementRepo } from '@/server/repos/engagement';
import { createMemoryRepos, type MemoryRepos } from '@/server/repos/memory';
import { MemoryEngagementRepo } from '@/server/repos/memory/engagement';
import { setRepos } from '@/server/repos/types';

const REPORT_POINT = { lat: 40.4862, lng: -74.4518 };
const MANHATTAN = { lat: 40.7128, lng: -74.006 };
const DAY = 86_400_000;
const JANE = { id: 'u_jane', display_name: 'Jane Doe', created_at: new Date(Date.now() - 400 * DAY).toISOString() };
const BOB = { id: 'u_bob', display_name: 'Bob Smith', created_at: new Date(Date.now() - 30 * DAY).toISOString() };
const NEWBIE = { id: 'u_new', display_name: 'New Person', created_at: new Date(Date.now() - 2 * DAY).toISOString() };
const INSPECTOR = { id: 'u_insp', display_name: 'Ida Inspector', role: 'inspector' as const, created_at: JANE.created_at };
const FORBIDDEN = /home_geom|phone|install_id|internal|reporter_id|uploader_id|client_draft_id|email|@example/;

const input = (over: Partial<CreateReportInput> = {}): CreateReportInput => ({
  clientDraftId: 'd_m2k9x1a3_7f3kq',
  category: 'vegetation',
  subtype: 'root_heave',
  severityResident: 2,
  injuryFlag: 'no',
  reporterDisplay: 'named',
  lat: REPORT_POINT.lat,
  lng: REPORT_POINT.lng,
  accuracyM: 8,
  locationConfirmed: true,
  addressText: '12 Somerset St',
  note: 'Lifted panel by the bus stop',
  photoIds: [],
  capturedAt: '2026-10-05T12:00:00.000Z',
  ...over,
});

const base = 'http://localhost/api/v1/reports/rc_000001';
const req = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => new Request(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const vote = (body?: unknown, id = 'rc_000001', headers: Record<string, string> = {}) => VOTE(req(`${base}/votes`, 'POST', body, headers), { id });
const unvote = (id = 'rc_000001') => UNVOTE(req(`${base}/votes`, 'DELETE'), { id });
const postComment = (body: unknown, id = 'rc_000001') => POST_COMMENT(req(`${base}/comments`, 'POST', body), { id });
const listComments = (id = 'rc_000001') => GET_COMMENTS(new Request(`${base}/comments`), { id });
const follow = (id = 'rc_000001') => FOLLOW(req(`${base}/follow`, 'POST'), { id });
const unfollow = (id = 'rc_000001') => UNFOLLOW(req(`${base}/follow`, 'DELETE'), { id });
const flagReport = (body: unknown, id = 'rc_000001') => FLAG_REPORT(req(`${base}/flag`, 'POST', body), { id });
const flagComment = (body: unknown, id: string) => FLAG_COMMENT(req(`http://localhost/api/v1/comments/${id}/flag`, 'POST', body), { id });
const publicReport = async (id = 'rc_000001') => (await (await GET_REPORT(new Request(`http://localhost/api/v1/reports/${id}`), { id })).json()).report;

let repos: MemoryRepos;
let engagement: MemoryEngagementRepo;
let limiter: MemoryRateLimiter;
let now: number;

beforeAll(() => setLogSink(() => {}));
afterAll(() => {
  setLogSink(null);
  setRepos(null);
  setEngagementRepo(null);
  setRateLimiter(null);
  setTestUser(undefined);
});

beforeEach(async () => {
  repos = createMemoryRepos();
  for (const u of [JANE, BOB, NEWBIE, INSPECTOR]) repos.users.seed(u);
  engagement = new MemoryEngagementRepo(repos.users, repos.reports);
  engagement.seedContext(BOB.id, { home: { lat: REPORT_POINT.lat + 0.002, lng: REPORT_POINT.lng } }); // ~220 m away
  setRepos(repos);
  setEngagementRepo(engagement);
  now = Date.now();
  limiter = new MemoryRateLimiter(() => now);
  setRateLimiter(limiter);
  setTestUser({ userId: JANE.id, role: 'resident' });
  await repos.reports.create(input(), { userId: JANE.id, role: 'resident', now: '2026-10-05T12:00:00.000Z', requestId: 'seed' });
  setTestUser({ userId: BOB.id, role: 'resident' });
});

describe('401 without a session on every write', () => {
  test('votes, comments, follow and both flags answer 401 and write nothing', async () => {
    setTestUser(null);
    for (const res of await Promise.all([vote({}), unvote(), postComment({ body: 'hi' }), follow(), unfollow(), flagReport({ reason: 'spam' }), flagComment({ reason: 'spam' }, 'cm_000001')])) {
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe('unauthenticated');
    }
    expect(engagement.votes).toHaveLength(0);
    expect(engagement.comments).toHaveLength(0);
    expect(engagement.follows).toHaveLength(0);
    expect(engagement.flags).toHaveLength(0);
    expect(repos.reports.rows[0].vote_count).toBe(1);
  });

  test('comments are readable without a session; auditors may not vote', async () => {
    setTestUser(null);
    expect((await listComments()).status).toBe(200);
    repos.users.seed({ id: 'u_audit', role: 'auditor' });
    setTestUser({ userId: 'u_audit', role: 'auditor' });
    expect((await vote({})).status).toBe(403);
  });
});

describe('POST/DELETE /api/v1/reports/[id]/votes', () => {
  test('201 with a VoteResponse, then 409 for the same account; the voter auto-follows', async () => {
    const res = await vote({ lat: REPORT_POINT.lat, lng: REPORT_POINT.lng }, 'rc_000001', { 'x-install-id': 'i_abc' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(VoteResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ reportId: 'rc_000001', voteCount: 2, voted: true });
    expect(JSON.stringify(body)).not.toMatch(FORBIDDEN);
    expect(engagement.votes[0]).toMatchObject({ report_id: 'rc_000001', user_id: BOB.id, weight: 1, unverified_geo: false, install_id: 'i_abc' });
    expect(engagement.follows).toEqual([expect.objectContaining({ report_id: 'rc_000001', user_id: BOB.id })]);

    const again = await vote({});
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe('conflict');
    expect(engagement.votes).toHaveLength(1);
    expect(repos.reports.rows[0].vote_count).toBe(2);
  });

  test('the public projection reflects the new count, score and community term', async () => {
    const before = await publicReport();
    await vote({});
    const after = await publicReport();
    expect(after.voteCount).toBe(2);
    const expectedCommunity = communityTerm(1 + 1, 0); // reporter's own weight 1 + Bob's full weight 1
    expect(after.scoreTerms.community).toBeCloseTo(expectedCommunity, 10);
    expect(after.scoreTerms.exposure).toBe(before.scoreTerms.exposure);
    expect(after.scoreTerms.severity).toBe(before.scoreTerms.severity);
    expect(after.score).toBe(scoreFromTerms(after.scoreTerms, DEFAULT_WEIGHTS, after.stormMultiplier));
    expect(after.score).toBeGreaterThan(before.score);
  });

  test('weight 0.6 for an account younger than 7 days, 0.6 without a home area, 1.0 with both', async () => {
    setTestUser({ userId: NEWBIE.id, role: 'resident' });
    await vote({});
    setTestUser({ userId: JANE.id, role: 'resident' }); // 400 days old, no home area seeded
    await vote({});
    setTestUser({ userId: BOB.id, role: 'resident' }); // 30 days, home area 220 m away
    await vote({});
    const byUser = Object.fromEntries(engagement.votes.map((v) => [v.user_id, v.weight]));
    expect(byUser).toEqual({ [NEWBIE.id]: 0.6, [JANE.id]: 0.6, [BOB.id]: 1 });
    expect(await engagement.voteWeightSum('rc_000001')).toBeCloseTo(1 + 0.6 + 0.6 + 1, 10);
    expect(repos.reports.rows[0].score_terms.community).toBeCloseTo(communityTerm(3.2, 0), 10);
  });

  test('geo check: device fix beyond 1.5 km → unverified_geo; no fix falls back to the home area; neither → unverified', async () => {
    expect((await vote(MANHATTAN)).status).toBe(201);
    expect(engagement.votes[0].unverified_geo).toBe(true);
    await unvote();
    expect((await vote({})).status).toBe(201); // Bob's home area is 220 m away
    expect(engagement.votes[0].unverified_geo).toBe(false);
    setTestUser({ userId: JANE.id, role: 'resident' });
    expect((await vote({})).status).toBe(201); // Jane has no home area and sent no fix
    expect(engagement.votes.find((v) => v.user_id === JANE.id)?.unverified_geo).toBe(true);
  });

  test('400 for a malformed body or an out-of-range point', async () => {
    expect((await vote('{nope')).status).toBe(400);
    expect((await vote({ lat: 91, lng: 0 })).status).toBe(400);
    expect(engagement.votes).toHaveLength(0);
  });

  test('404 for an unknown report', async () => {
    expect((await vote({}, 'rc_nope')).status).toBe(404);
    expect((await unvote('rc_nope')).status).toBe(404);
  });

  test('DELETE is idempotent, rescored, and never drops the reporter’s own vote', async () => {
    await vote({});
    const res = await unvote();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reportId: 'rc_000001', voteCount: 1, voted: false });
    expect(engagement.votes).toHaveLength(0);
    expect(repos.reports.rows[0].score_terms.community).toBeCloseTo(communityTerm(1, 0), 10);
    const replay = await unvote();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ voteCount: 1, voted: false });
    expect(engagement.follows).toHaveLength(1); // following is separate from voting
  });

  test('25 votes set supervisor_review once with one event; 100 set council_item', async () => {
    const voteAs = async (n: number) => {
      const id = `u_v${String(n).padStart(3, '0')}`;
      repos.users.seed({ id, display_name: `Voter ${n}`, created_at: JANE.created_at });
      setTestUser({ userId: id, role: 'resident' });
      expect((await vote({})).status).toBe(201);
    };
    for (let n = 1; n <= VOTE_THRESHOLDS.supervisorReview - 2; n++) await voteAs(n); // 1 (reporter) + 23 = 24
    expect(repos.reports.rows[0].vote_count).toBe(24);
    expect(repos.reports.rows[0].flags.supervisor_review).toBeUndefined();
    await voteAs(24);
    expect(repos.reports.rows[0].vote_count).toBe(25);
    expect(repos.reports.rows[0].flags).toEqual({ supervisor_review: true });
    const events = () => repos.reports.rows[0].events.filter((e) => e.kind.startsWith('threshold_'));
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ kind: 'threshold_supervisor_review', actor_type: 'system', actor_id: null, note: '25 urgency votes — flagged for supervisor review' });
    for (let n = 25; n <= VOTE_THRESHOLDS.councilItem - 1; n++) await voteAs(n);
    expect(repos.reports.rows[0].vote_count).toBe(100);
    expect(repos.reports.rows[0].flags).toEqual({ supervisor_review: true, council_item: true });
    expect(events().map((e) => e.kind)).toEqual(['threshold_supervisor_review', 'threshold_council_item']);
    // the flag and events are sticky: removing a vote does not unset them
    await unvote();
    expect(repos.reports.rows[0].vote_count).toBe(99);
    expect(repos.reports.rows[0].flags.council_item).toBe(true);
    const timeline = (await publicReport()).timeline;
    expect(timeline.filter((e: { kind: string }) => e.kind.startsWith('threshold_'))).toHaveLength(2);
  });

  test('429 with Retry-After after VOTE_LIMIT.perWindow votes and unvotes in an hour, per account', async () => {
    for (let i = 0; i < VOTE_LIMIT.perWindow; i++) expect((await (i % 2 === 0 ? vote({}) : unvote())).status).toBe(i % 2 === 0 ? 201 : 200);
    const res = await vote({});
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(VOTE_LIMIT.windowSec));
    setTestUser({ userId: JANE.id, role: 'resident' });
    expect((await vote({})).status).toBe(201);
    setTestUser({ userId: BOB.id, role: 'resident' });
    now += VOTE_LIMIT.windowSec * 1000 + 1;
    expect((await vote({})).status).toBe(201);
  });
});

describe('/api/v1/reports/[id]/comments', () => {
  test('the filter rejects links and profanity with the moderation message; valid comments are stored', async () => {
    const link = await postComment({ body: 'see https://example.com/x' });
    expect(link.status).toBe(400);
    expect((await link.json()).error.message).toMatch(/Links are not allowed/);
    const rude = await postComment({ body: 'fix this shit' });
    expect(rude.status).toBe(400);
    expect((await rude.json()).error.message).toMatch(/not allowed/);
    expect((await postComment({ body: '' })).status).toBe(400);
    expect((await postComment({ body: 'a'.repeat(1001) })).status).toBe(400);
    expect((await postComment('{nope')).status).toBe(400);
    expect(engagement.comments).toHaveLength(0);
    const ok = await postComment({ body: '  Still there this morning.  ' });
    expect(ok.status).toBe(201);
    const { comment } = await ok.json();
    expect(comment).toMatchObject({ id: 'cm_000001', body: 'Still there this morning.', authorDisplay: 'B.S.', isStaff: false });
    expect(JSON.stringify(comment)).not.toMatch(FORBIDDEN);
    expect((await publicReport()).commentCount).toBe(1);
  });

  test('author display: reporter by identity choice, residents by initials, staff by name, deleted accounts as former user', async () => {
    const report = repos.reports.rows[0];
    expect(commentAuthorDisplay({ user_id: JANE.id, author_display_name: 'Jane Doe', is_staff: false }, report)).toBe('Jane Doe');
    expect(commentAuthorDisplay({ user_id: JANE.id, author_display_name: 'Jane Doe', is_staff: false }, { ...report, reporter_display: 'initials' })).toBe('J.D.');
    expect(commentAuthorDisplay({ user_id: BOB.id, author_display_name: 'Bob Smith', is_staff: false }, report)).toBe('B.S.');
    expect(commentAuthorDisplay({ user_id: BOB.id, author_display_name: null, is_staff: false }, report)).toBe('Resident');
    expect(commentAuthorDisplay({ user_id: INSPECTOR.id, author_display_name: 'Ida Inspector', is_staff: true }, report)).toBe('Ida Inspector');
    expect(commentAuthorDisplay({ user_id: INSPECTOR.id, author_display_name: null, is_staff: true }, report)).toBe('City staff');
    expect(commentAuthorDisplay({ user_id: null, author_display_name: null, is_staff: false }, report)).toBe('Former user');
  });

  test('internal notes need an inspector and never appear in the public list or count', async () => {
    const denied = await postComment({ body: 'resident is a repeat caller', isInternal: true });
    expect(denied.status).toBe(403);
    expect(engagement.comments).toHaveLength(0);
    setTestUser({ userId: INSPECTOR.id, role: 'inspector' });
    const internal = await postComment({ body: 'Inspection booked for Thursday', isInternal: true });
    expect(internal.status).toBe(201);
    const pub = await postComment({ body: 'We have scheduled an inspection this week.' });
    expect(pub.status).toBe(201);
    expect((await pub.json()).comment).toMatchObject({ authorDisplay: 'Ida Inspector', isStaff: true });
    const list = await (await listComments()).json();
    expect(CommentsResponseSchema.safeParse(list).success).toBe(true);
    expect(list.comments.map((c: { body: string }) => c.body)).toEqual(['We have scheduled an inspection this week.']);
    expect(JSON.stringify(list)).not.toMatch(/Thursday|internal|email/);
    expect((await publicReport()).commentCount).toBe(1);
    expect(engagement.comments.find((c) => c.is_internal)?.body).toBe('Inspection booked for Thursday');
  });

  test('GET lists visible comments oldest first and 404s for an unknown report; hidden comments are skipped', async () => {
    await postComment({ body: 'First' });
    setTestUser({ userId: JANE.id, role: 'resident' });
    await postComment({ body: 'Second, from the reporter' });
    engagement.comments[0].hidden = true;
    const list = await (await listComments()).json();
    expect(list.comments.map((c: { body: string; authorDisplay: string }) => [c.body, c.authorDisplay])).toEqual([['Second, from the reporter', 'Jane Doe']]);
    expect((await listComments('rc_nope')).status).toBe(404);
    expect((await postComment({ body: 'hi' }, 'rc_nope')).status).toBe(404);
  });

  test('429 after COMMENT_LIMIT.perWindow comments in an hour', async () => {
    for (let i = 0; i < COMMENT_LIMIT.perWindow; i++) expect((await postComment({ body: `Comment ${i}` })).status).toBe(201);
    const res = await postComment({ body: 'one more' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(COMMENT_LIMIT.windowSec));
  });
});

describe('/api/v1/reports/[id]/follow', () => {
  test('POST 201 then 200 on replay, DELETE 200 twice; 404 for an unknown report', async () => {
    const first = await follow();
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ reportId: 'rc_000001', following: true });
    expect((await follow()).status).toBe(200);
    expect(engagement.follows).toHaveLength(1);
    const off = await unfollow();
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ reportId: 'rc_000001', following: false });
    expect((await unfollow()).status).toBe(200);
    expect(engagement.follows).toHaveLength(0);
    expect((await follow('rc_nope')).status).toBe(404);
  });
});

describe('flags', () => {
  test('report and comment flags write content_flag rows with the reason and note; 404 for unknown targets; 400 for a bad reason', async () => {
    const res = await flagReport({ reason: 'privacy', note: 'a face is visible' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ flagId: 'cf_000001', status: 'open' });
    expect(engagement.flags[0]).toMatchObject({ target_type: 'report', target_id: 'rc_000001', reporter_id: BOB.id, reason: 'privacy\na face is visible', status: 'open' });
    await postComment({ body: 'A comment to flag' });
    const cm = engagement.comments[0].id;
    expect((await flagComment({ reason: 'abuse' }, cm)).status).toBe(201);
    expect(engagement.flags[1]).toMatchObject({ target_type: 'comment', target_id: cm, reason: 'abuse' });
    expect((await flagComment({ reason: 'abuse' }, 'cm_nope')).status).toBe(404);
    expect((await flagReport({ reason: 'abuse' }, 'rc_nope')).status).toBe(404);
    expect((await flagReport({ reason: 'because' })).status).toBe(400);
    expect(engagement.flags).toHaveLength(2);
  });

  test('10 a day per account across both targets, then 429 with a one-day Retry-After', async () => {
    expect(FLAG_LIMIT).toEqual({ perWindow: 10, windowSec: 86_400 });
    await postComment({ body: 'A comment to flag' });
    const cm = engagement.comments[0].id;
    for (let i = 0; i < FLAG_LIMIT.perWindow; i++) expect((await (i % 2 === 0 ? flagReport({ reason: 'spam' }) : flagComment({ reason: 'spam' }, cm))).status).toBe(201);
    const res = await flagReport({ reason: 'spam' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('86400');
    setTestUser({ userId: JANE.id, role: 'resident' });
    expect((await flagReport({ reason: 'spam' })).status).toBe(201);
  });
});
