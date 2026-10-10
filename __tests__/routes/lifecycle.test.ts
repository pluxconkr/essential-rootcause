/**
 * PATCH /api/v1/reports/[id] and POST /api/v1/reports/[id]/verify against the memory repos (plan §14, §7; spec status
 * table and §4.4): 401 without a session · 403 for residents, stewards and auditors · the inspector walks a report
 * new → triaged → assessed with `status` events, a confirmed band that is audited and rescored, and a push to the
 * reporter · 409 for a move the machine refuses · 422 when `completed` lacks an after-photo or `rejected` a reason ·
 * the after-photo is attached as `after` · after a reopen the rejected fix's after-photo no longer counts ·
 * `verified` is never a staff target · verify: 401/403 · 409 unless `completed` · one verdict per account per
 * completion (replay 200) · two confirmations → `verified` with a system event and a push · a bare rejection records
 * only · a rejection with a photo reopens to `assessed` one band higher, audited, pushed · after a second `completed`
 * the tallies start over · a photo already on a report is refused as proof (409) · the note is filtered like a
 * comment · nothing public carries ids that are not public.
 */
import { GET as GET_REPORT, PATCH, STATUS_ACTION } from '@/app/api/v1/reports/[id]+api';
import { POST as VERIFY } from '@/app/api/v1/reports/[id]/verify+api';
import { DEFAULT_WEIGHTS, scoreFromTerms, severityTerm } from '@/domain/score';
import { REOPEN_REJECTIONS, RESIDENT_WORDING, VERIFY_CONFIRMATIONS } from '@/domain/status';
import { PublicReportSchema, VerifyResponseSchema, type CreateReportInput } from '@/domain/types';
import { setTestUser, type AuthedUser } from '@/server/auth';
import { REOPEN_NOTE, VERIFIED_NOTE, escalatedBand } from '@/server/lifecycle';
import { setLogSink } from '@/server/log';
import { setPushSender, type ExpoPushMessage } from '@/server/push';
import { setEngagementRepo } from '@/server/repos/engagement';
import { setLifecycleRepo } from '@/server/repos/lifecycle';
import { createMemoryRepos, type MemoryRepos } from '@/server/repos/memory';
import { MemoryEngagementRepo } from '@/server/repos/memory/engagement';
import { setRepos } from '@/server/repos/types';

const NOW = '2026-10-05T12:00:00.000Z';
const JANE = { id: 'u_jane', display_name: 'Jane Doe' };
const BOB = { id: 'u_bob', display_name: 'Bob Smith' };
const CARL = { id: 'u_carl', display_name: 'Carl Chen' };
const DANA = { id: 'u_dana', display_name: 'Dana Ortiz' };
const STEWARD = { id: 'u_stew', display_name: 'Sam Steward', role: 'steward' as const };
const INSPECTOR = { id: 'u_insp', display_name: 'Ida Inspector', role: 'inspector' as const };
const SUPERVISOR = { id: 'u_sup', display_name: 'Sue Supervisor', role: 'supervisor' as const };
const AUDITOR = { id: 'u_audit', display_name: 'Al Auditor', role: 'auditor' as const };
const FORBIDDEN = /home_geom|phone|install_id|internal|reporter_id|uploader_id|client_draft_id|actor_id|email|@example/;
const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const token = (s: string) => `ExponentPushToken[${s}]`;

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

const url = (id: string, tail = '') => `http://localhost/api/v1/reports/${id}${tail}`;
const req = (path: string, method: string, body?: unknown) => new Request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const patch = (body: unknown, id = 'rc_000001') => PATCH(req(url(id), 'PATCH', body), { id });
const verify = (body: unknown, id = 'rc_000001') => VERIFY(req(url(id, '/verify'), 'POST', body), { id });
const publicReport = async (id = 'rc_000001') => (await (await GET_REPORT(new Request(url(id)), { id })).json()).report;
const as = (user: { id: string; role?: AuthedUser['role'] } | null) => setTestUser(user ? { userId: user.id, role: user.role ?? 'resident' } : null);

let repos: MemoryRepos;
let engagement: MemoryEngagementRepo;
let sent: ExpoPushMessage[];

const row = () => repos.reports.rows[0];
const events = (kind?: string) => row().events.filter((e) => !kind || e.kind === kind);
const putPhoto = async (uploaderId: string) => (await repos.photos.put({ uploaderId, full: bytes, thumb: bytes, width: 640, height: 480, now: NOW })).id;
/** The completion cycle is bounded by timestamps the routes take from the clock: lets it move past a reopen before the next `completed`. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 2));

/** The inspector walks the report to `completed` with an after-photo — the state every verdict needs. */
async function complete(): Promise<void> {
  as(INSPECTOR);
  expect((await patch({ to: 'triaged' })).status).toBe(200);
  expect((await patch({ to: 'assessed' })).status).toBe(200);
  expect((await patch({ to: 'completed', afterPhotoId: await putPhoto(INSPECTOR.id), note: 'Panel replaced' })).status).toBe(200);
  sent.length = 0;
}

beforeAll(() => setLogSink(() => {}));
afterAll(() => {
  setLogSink(null);
  setRepos(null);
  setEngagementRepo(null);
  setLifecycleRepo(null);
  setPushSender(null);
  setTestUser(undefined);
});

beforeEach(async () => {
  repos = createMemoryRepos();
  for (const u of [JANE, BOB, CARL, DANA, STEWARD, INSPECTOR, SUPERVISOR, AUDITOR]) repos.users.seed(u);
  engagement = new MemoryEngagementRepo(repos.users, repos.reports);
  engagement.seedDevice({ user_id: JANE.id, expo_push_token: token('jane'), platform: 'ios' });
  engagement.seedDevice({ user_id: BOB.id, expo_push_token: token('bob'), platform: 'android' });
  setRepos(repos);
  setEngagementRepo(engagement);
  setLifecycleRepo(repos.lifecycle);
  sent = [];
  setPushSender({
    async send(messages) {
      sent.push(...messages);
      return messages.map((m) => ({ status: 'ok' as const, id: `t_${String(m.to)}` }));
    },
  });
  await repos.reports.create(input(), { userId: JANE.id, role: 'resident', now: NOW, requestId: 'seed' });
  await engagement.follow('rc_000001', BOB.id, NOW);
  as(INSPECTOR);
});

describe('PATCH /api/v1/reports/[id]', () => {
  test('401 without a session; 403 for a resident, a steward and an auditor; nothing changes', async () => {
    as(null);
    const none = await patch({ to: 'triaged' });
    expect(none.status).toBe(401);
    expect((await none.json()).error.code).toBe('unauthenticated');
    for (const user of [JANE, STEWARD, AUDITOR]) {
      as(user);
      const res = await patch({ to: 'triaged' });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('forbidden');
    }
    expect(row().status).toBe('new');
    expect(events()).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(STATUS_ACTION).toMatchObject({ triaged: 'triage', assessed: 'confirm_severity', mitigated: 'mitigate', scheduled: 'schedule', completed: 'complete', rejected: 'triage' });
  });

  test('inspector: new → triaged → assessed writes status events, audits and rescores a confirmed band, and pushes the reporter and followers', async () => {
    const res = await patch({ to: 'triaged', note: 'Inspector confirmed on site' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(PublicReportSchema.safeParse(body.report).success).toBe(true);
    expect(body.report.status).toBe('triaged');
    expect(JSON.stringify(body)).not.toMatch(FORBIDDEN);
    expect(events('status')).toEqual([expect.objectContaining({ actor_type: 'staff', actor_id: INSPECTOR.id, from_status: 'new', to_status: 'triaged', note: 'Inspector confirmed on site', created_at: expect.any(String) })]);
    expect(sent.map((m) => [m.to, m.data])).toEqual(
      expect.arrayContaining([
        [token('jane'), { kind: 'status', reportId: 'rc_000001', from: 'new', to: 'triaged' }],
        [token('bob'), { kind: 'status', reportId: 'rc_000001', from: 'new', to: 'triaged' }],
      ]),
    );
    expect(sent[0].title).toContain(RESIDENT_WORDING.triaged);

    const assessed = await patch({ to: 'assessed', severityConfirmed: 3 });
    expect(assessed.status).toBe(200);
    const report = (await assessed.json()).report;
    expect(report).toMatchObject({ status: 'assessed', severity: 3, severityConfirmed: true });
    expect(row().score_terms.severity).toBe(severityTerm(3));
    expect(row().score).toBe(scoreFromTerms(row().score_terms, DEFAULT_WEIGHTS, row().storm_multiplier));
    expect(repos.lifecycle.severityAudits).toEqual([expect.objectContaining({ report_id: 'rc_000001', ai_value: null, human_value: 3, inspector_id: INSPECTOR.id })]);
    expect((await publicReport()).timeline.map((e: { kind: string; toStatus: string | null }) => [e.kind, e.toStatus])).toEqual([
      ['created', 'new'],
      ['status', 'triaged'],
      ['status', 'assessed'],
    ]);
  });

  test('409 invalid_transition for a move the machine refuses or a status already held; 404 unknown; 400 bad body', async () => {
    for (const to of ['assessed', 'new', 'verified', 'completed']) {
      const res = await patch({ to });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('invalid_transition');
    }
    expect((await patch({ to: 'triaged' }, 'rc_nope')).status).toBe(404);
    expect((await patch('{nope')).status).toBe(400);
    expect((await patch({ to: 'later' })).status).toBe(400);
    expect((await patch({ to: 'triaged', severityConfirmed: 5 })).status).toBe(400);
    expect(row().status).toBe('new');
    expect(events()).toHaveLength(1);
  });

  test('`completed` needs an after-photo: 422 without one, 404 for an unknown photo, 200 once a pending upload is attached as `after`', async () => {
    await patch({ to: 'triaged' });
    await patch({ to: 'assessed' });
    const bare = await patch({ to: 'completed' });
    expect(bare.status).toBe(422);
    expect((await bare.json()).error).toMatchObject({ code: 'invalid_transition', message: expect.stringMatching(/after-photo/) });
    expect((await patch({ to: 'completed', afterPhotoId: 'ph_nope' })).status).toBe(404);
    expect(row().status).toBe('assessed');

    const photoId = await putPhoto(INSPECTOR.id);
    const done = await patch({ to: 'completed', afterPhotoId: photoId, note: 'Panel replaced — please confirm' });
    expect(done.status).toBe(200);
    expect(row().status).toBe('completed');
    expect(repos.photos.rows.find((p) => p.id === photoId)).toMatchObject({ report_id: 'rc_000001', phase: 'after' });
    expect(events('status').at(-1)).toMatchObject({ from_status: 'assessed', to_status: 'completed', note: 'Panel replaced — please confirm' });
    expect((await patch({ to: 'completed', afterPhotoId: photoId })).status).toBe(409);
  });

  test('after a reopen, `completed` needs a new after-photo: the rejected fix’s photo no longer counts, one uploaded since the reopen does', async () => {
    await complete();
    const oldAfterId = repos.photos.rows.find((p) => p.phase === 'after')!.id;
    as(CARL);
    expect((await verify({ verdict: 'rejected', photoId: await putPhoto(CARL.id) })).status).toBe(201);
    expect(row().status).toBe('assessed');
    const reopenedAt = events('status').at(-1)!.created_at;

    as(INSPECTOR);
    const bare = await patch({ to: 'completed' });
    expect(bare.status).toBe(422);
    expect((await bare.json()).error.message).toMatch(/after-photo/);
    expect((await patch({ to: 'completed', afterPhotoId: oldAfterId })).status).toBe(422);
    expect(row().status).toBe('assessed');

    // An after-photo added since the reopen by another path (POST /reports/:id/photos) counts by its upload time.
    const later = await repos.photos.put({ uploaderId: INSPECTOR.id, full: bytes, thumb: bytes, width: 640, height: 480, now: reopenedAt });
    await repos.photos.attach([later.id], { reportId: 'rc_000001', anonymous: false, phase: 'after' });
    expect((await patch({ to: 'completed' })).status).toBe(200);
    expect(row().status).toBe('completed');
  });

  test('`scheduled` is the supervisor’s move; `rejected` needs a reason and closes the report', async () => {
    await patch({ to: 'triaged' });
    await patch({ to: 'assessed' });
    expect((await patch({ to: 'scheduled' })).status).toBe(403);
    as(SUPERVISOR);
    expect((await patch({ to: 'scheduled', note: 'Crew window Tue 7–11' })).status).toBe(200);
    const noReason = await patch({ to: 'rejected' });
    expect(noReason.status).toBe(422);
    expect((await noReason.json()).error.message).toMatch(/reason/);
    expect((await patch({ to: 'rejected', note: 'Private driveway — owner notified' })).status).toBe(200);
    expect(row().status).toBe('rejected');
    expect((await patch({ to: 'triaged' })).status).toBe(409);
    expect(sent.at(-1)?.data).toEqual({ kind: 'status', reportId: 'rc_000001', from: 'scheduled', to: 'rejected' });
  });
});

describe('POST /api/v1/reports/[id]/verify', () => {
  test('401 without a session, 403 for an auditor, 409 unless the report is completed; nothing is recorded', async () => {
    as(null);
    expect((await verify({ verdict: 'confirmed' })).status).toBe(401);
    as(AUDITOR);
    expect((await verify({ verdict: 'confirmed' })).status).toBe(403);
    as(BOB);
    const early = await verify({ verdict: 'confirmed' });
    expect(early.status).toBe(409);
    expect((await early.json()).error).toMatchObject({ code: 'invalid_transition', message: expect.stringContaining(RESIDENT_WORDING.new) });
    expect((await verify({ verdict: 'confirmed' }, 'rc_nope')).status).toBe(404);
    expect((await verify({ verdict: 'maybe' })).status).toBe(400);
    expect(repos.lifecycle.verifications).toHaveLength(0);
  });

  test(`${VERIFY_CONFIRMATIONS} confirmations close the order: 201, a 200 replay for the same account, then verified with a system event and a push`, async () => {
    expect(VERIFY_CONFIRMATIONS).toBe(2);
    await complete();
    as(BOB);
    const first = await verify({ verdict: 'confirmed' });
    expect(first.status).toBe(201);
    const body = await first.json();
    expect(VerifyResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ verdict: 'confirmed', confirmations: 1, rejections: 0 });
    expect(body.report.status).toBe('completed');
    expect(JSON.stringify(body)).not.toMatch(FORBIDDEN);

    const replay = await verify({ verdict: 'rejected' });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ verdict: 'confirmed', confirmations: 1, rejections: 0 });
    expect(repos.lifecycle.verifications).toHaveLength(1);
    expect(row().status).toBe('completed');
    expect(sent).toHaveLength(0);

    as(CARL);
    const second = await verify({ verdict: 'confirmed' });
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ verdict: 'confirmed', confirmations: 2, rejections: 0, report: { status: 'verified' } });
    expect(row().status).toBe('verified');
    expect(events('verification')).toHaveLength(2);
    expect(events('status').at(-1)).toMatchObject({ actor_type: 'system', actor_id: null, from_status: 'completed', to_status: 'verified', note: VERIFIED_NOTE });
    expect(sent.map((m) => [m.to, m.data])).toEqual(
      expect.arrayContaining([
        [token('jane'), { kind: 'status', reportId: 'rc_000001', from: 'completed', to: 'verified' }],
        [token('bob'), { kind: 'status', reportId: 'rc_000001', from: 'completed', to: 'verified' }],
      ]),
    );

    as(DANA);
    expect((await verify({ verdict: 'confirmed' })).status).toBe(409);
    expect(repos.lifecycle.verifications).toHaveLength(2);
  });

  test('a bare rejection is recorded and changes nothing; a rejection with a photo reopens to assessed one band higher, audited and pushed', async () => {
    expect(REOPEN_REJECTIONS).toBe(1);
    await complete();
    as(BOB);
    const bare = await verify({ verdict: 'rejected', note: 'The lip is still there' });
    expect(bare.status).toBe(201);
    expect(await bare.json()).toMatchObject({ verdict: 'rejected', confirmations: 0, rejections: 1, report: { status: 'completed' } });
    expect(row().status).toBe('completed');
    expect(events('verification').at(-1)).toMatchObject({ actor_type: 'resident', actor_id: BOB.id, note: 'A resident reports the hazard is still there — The lip is still there' });
    expect(sent).toHaveLength(0);

    as(CARL);
    const photoId = await putPhoto(CARL.id);
    const before = { ...row() };
    expect(escalatedBand(before)).toBe(3); // resident band 2, nothing confirmed → one band up
    const reopen = await verify({ verdict: 'rejected', photoId });
    expect(reopen.status).toBe(201);
    const body = await reopen.json();
    expect(body).toMatchObject({ verdict: 'rejected', confirmations: 0, rejections: 2, report: { status: 'assessed', severity: 3, severityConfirmed: true } });
    expect(row().severity_confirmed).toBe(3);
    expect(row().score_terms.severity).toBe(severityTerm(3));
    expect(row().score).toBe(scoreFromTerms(row().score_terms, DEFAULT_WEIGHTS, row().storm_multiplier));
    expect(row().score).toBeGreaterThan(before.score);
    expect(repos.lifecycle.severityAudits.at(-1)).toMatchObject({ report_id: 'rc_000001', human_value: 3, inspector_id: null, reason: REOPEN_NOTE });
    expect(repos.lifecycle.verifications.at(-1)).toMatchObject({ user_id: CARL.id, verdict: 'rejected', photo_id: photoId });
    expect(repos.photos.rows.find((p) => p.id === photoId)).toMatchObject({ report_id: 'rc_000001', phase: 'before', uploader_id: CARL.id });
    expect(events('status').at(-1)).toMatchObject({ actor_type: 'system', actor_id: null, from_status: 'completed', to_status: 'assessed', note: REOPEN_NOTE });
    expect(sent.map((m) => m.data)).toContainEqual({ kind: 'status', reportId: 'rc_000001', from: 'completed', to: 'assessed' });

    const replay = await verify({ verdict: 'confirmed' });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ verdict: 'rejected', rejections: 2, report: { status: 'assessed' } });
    as(DANA);
    expect((await verify({ verdict: 'confirmed' })).status).toBe(409);
  });

  test('after a reopen and a second `completed` the tallies start over: a bare rejection records only, every account answers again, two new confirmations verify', async () => {
    await complete();
    as(BOB);
    expect((await verify({ verdict: 'confirmed' })).status).toBe(201);
    as(CARL);
    expect((await verify({ verdict: 'rejected', photoId: await putPhoto(CARL.id) })).status).toBe(201);
    expect(row()).toMatchObject({ status: 'assessed', severity_confirmed: 3 });
    await tick();
    as(INSPECTOR);
    expect((await patch({ to: 'completed', afterPhotoId: await putPhoto(INSPECTOR.id), note: 'Panel replaced again' })).status).toBe(200);
    sent.length = 0;

    as(DANA);
    const bare = await verify({ verdict: 'rejected' });
    expect(bare.status).toBe(201);
    expect(await bare.json()).toMatchObject({ verdict: 'rejected', confirmations: 0, rejections: 1, report: { status: 'completed' } });
    expect(row()).toMatchObject({ status: 'completed', severity_confirmed: 3 });
    expect(sent).toHaveLength(0);

    as(BOB);
    const fresh = await verify({ verdict: 'confirmed' });
    expect(fresh.status).toBe(201);
    expect(await fresh.json()).toMatchObject({ verdict: 'confirmed', confirmations: 1, rejections: 1, report: { status: 'completed' } });
    expect((await verify({ verdict: 'rejected' })).status).toBe(200);
    expect(repos.lifecycle.verifications.filter((v) => v.user_id === BOB.id)).toHaveLength(2);
    expect(row().status).toBe('completed');

    as(CARL);
    const second = await verify({ verdict: 'confirmed' });
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ verdict: 'confirmed', confirmations: 2, rejections: 1, report: { status: 'verified' } });
    expect(row().status).toBe('verified');
    expect(events('status').at(-1)).toMatchObject({ actor_type: 'system', from_status: 'completed', to_status: 'verified', note: VERIFIED_NOTE });
    expect(sent.map((m) => m.data)).toContainEqual({ kind: 'status', reportId: 'rc_000001', from: 'completed', to: 'verified' });
  });

  test('the escalation stops at band 4', async () => {
    await complete();
    row().severity_confirmed = 4;
    as(CARL);
    expect((await verify({ verdict: 'rejected', photoId: await putPhoto(CARL.id) })).status).toBe(201);
    expect(row()).toMatchObject({ status: 'assessed', severity_confirmed: 4 });
    expect(repos.lifecycle.severityAudits.at(-1)).toMatchObject({ human_value: 4, reason: REOPEN_NOTE });
  });

  test('the photo must be the resident’s own pending upload, and the note passes the comment filter; nothing is recorded otherwise', async () => {
    await complete();
    as(CARL);
    expect((await verify({ verdict: 'rejected', photoId: 'ph_nope' })).status).toBe(404);
    expect((await verify({ verdict: 'rejected', photoId: await putPhoto(BOB.id) })).status).toBe(403);
    const afterId = repos.photos.rows.find((p) => p.report_id === 'rc_000001' && p.phase === 'after')!.id;
    const attached = await verify({ verdict: 'rejected', photoId: afterId });
    expect(attached.status).toBe(409);
    expect((await attached.json()).error.code).toBe('conflict');
    const link = await verify({ verdict: 'rejected', note: 'see https://example.com/proof' });
    expect(link.status).toBe(400);
    expect((await link.json()).error.message).toMatch(/Links are not allowed/);
    expect(repos.lifecycle.verifications).toHaveLength(0);
    expect(row().status).toBe('completed');
  });
});
