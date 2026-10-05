/**
 * POST /api/jobs/tick and the dispatcher against the memory repos (plan §11, §14): 503 when JOB_SECRET or the
 * Supabase env is unset, 401 without or with a wrong secret, and one tick runs every due job once — autoVerify
 * flips a 15-day-old completed report and leaves judged or fresh ones; coarsenGps snaps an anonymous 31-day-old
 * report onto the 50 m grid and leaves a named one and a young anonymous one; purgePhotos removes a 25-hour-old
 * pending photo with its storage objects and keeps a 2-hour-old one; recompute moves the decay term of a 100-day-old
 * open report and recomputes its score from stored inputs. A second tick skips the nightly jobs as not due; the
 * deadline and a failing job are handled without losing the cursor or last_ok_at.
 */
import { JOB_SECRET_HEADER, POST, secretMatches } from '@/app/api/jobs/tick+api';
import { distanceM, snapToGrid } from '@/domain/geo';
import { decayTerm, exposureTerm, scoreFromTerms } from '@/domain/score';
import { DAY_MS, localMinutes } from '@/domain/time';
import type { CreateReportInput } from '@/domain/types';
import { resetServiceClient } from '@/server/db';
import { AUTO_VERIFY_NOTE } from '@/server/jobs/autoVerify';
import { JOBS, NIGHTLY_LOCAL_MINUTES, dueState, latestNightlyBoundary, tick } from '@/server/jobs/tick';
import { setLogSink } from '@/server/log';
import { MemoryJobsStore, setJobsStore, type JobRunRow } from '@/server/repos/jobs';
import { createMemoryRepos, type MemoryRepos } from '@/server/repos/memory';

const SECRET = 'job-secret-for-tests';
const NOW = Date.parse('2026-10-05T12:00:00.000Z'); // 08:00 in New Brunswick — after the 02:00 nightly boundary
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR_MS = 3_600_000;
const url = 'http://localhost/api/jobs/tick';
const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JOB_SECRET'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

const post = (headers: Record<string, string> = {}) => POST(new Request(url, { method: 'POST', headers }));
const authed = () => post({ [JOB_SECRET_HEADER]: SECRET });

const input = (over: Partial<CreateReportInput> = {}): CreateReportInput => ({
  clientDraftId: `d_${Math.random().toString(36).slice(2, 10)}_test`,
  category: 'vegetation',
  subtype: 'root_heave',
  severityResident: 2,
  injuryFlag: 'no',
  reporterDisplay: 'named',
  lat: 40.4862,
  lng: -74.4518,
  accuracyM: 8,
  locationConfirmed: true,
  photoIds: [],
  capturedAt: iso(NOW),
  ...over,
});

let repos: MemoryRepos;
let store: MemoryJobsStore;
let nowSpy: jest.SpyInstance<number, []>;

/** A report created `ageDays` ago; returns its row. */
async function seedReport(ageDays: number, over: Partial<CreateReportInput> = {}) {
  const { row } = await repos.reports.create(input(over), { userId: 'u_jane', role: 'resident', now: iso(NOW - ageDays * DAY_MS), requestId: 'seed' });
  return repos.reports.rows.find((r) => r.id === row.id)!;
}

/** Moves a seeded report into `completed` as of `completedDaysAgo`. */
function complete(row: (typeof repos.reports.rows)[number], completedDaysAgo: number) {
  row.status = 'completed';
  row.events.push({ id: `ev_done_${row.id}`, kind: 'status', actor_type: 'staff', actor_id: 'u_insp', from_status: 'scheduled', to_status: 'completed', note: null, created_at: iso(NOW - completedDaysAgo * DAY_MS) });
}

beforeAll(() => {
  setLogSink(() => {});
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterAll(() => {
  setLogSink(null);
  setJobsStore(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetServiceClient();
});

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-for-tests';
  process.env.JOB_SECRET = SECRET;
  resetServiceClient();
  repos = createMemoryRepos();
  repos.users.seed({ id: 'u_jane', display_name: 'Jane Doe' });
  store = new MemoryJobsStore(repos.reports);
  setJobsStore(store);
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => nowSpy.mockRestore());

describe('secret handling', () => {
  test('secretMatches is exact and tolerates a missing header', async () => {
    expect(await secretMatches(SECRET, SECRET)).toBe(true);
    expect(await secretMatches('job-secret-for-tests!', SECRET)).toBe(false);
    expect(await secretMatches('x', SECRET)).toBe(false);
    expect(await secretMatches('', SECRET)).toBe(false);
    expect(await secretMatches(null, SECRET)).toBe(false);
  });

  test('401 without the header or with a wrong secret; nothing runs', async () => {
    let res = await post();
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
    res = await post({ [JOB_SECRET_HEADER]: 'nope' });
    expect(res.status).toBe(401);
    expect(store.runs.size).toBe(0);
  });

  test('503 when JOB_SECRET is unset, and when the Supabase env is missing', async () => {
    delete process.env.JOB_SECRET;
    let res = await authed();
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('misconfigured');
    process.env.JOB_SECRET = SECRET;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    resetServiceClient();
    res = await authed();
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('misconfigured');
    expect(store.runs.size).toBe(0);
  });
});

describe('one tick runs every due job against the memory repos', () => {
  test('autoVerify, coarsenGps, purgePhotos and recompute do their nightly work; pushReceipts is a recorded no-op', async () => {
    // autoVerify: completed 15 d ago with no verdict → verified; 3 d ago → untouched; 20 d ago but judged → untouched
    const stale = await seedReport(40, { clientDraftId: 'd_stale_completed' });
    complete(stale, 15);
    const fresh = await seedReport(40, { clientDraftId: 'd_fresh_completed' });
    complete(fresh, 3);
    const judged = await seedReport(40, { clientDraftId: 'd_judged_completed' });
    complete(judged, 20);
    store.verifications.push({ report_id: judged.id, verdict: 'confirmed' });

    // coarsenGps: anonymous 31 d → snapped; named 31 d → precise; anonymous 5 d → precise
    const precise = { lat: 40.48731, lng: -74.44629 };
    const anonOld = await seedReport(31, { clientDraftId: 'd_anon_old', reporterDisplay: 'anonymous', ...precise });
    const namedOld = await seedReport(31, { clientDraftId: 'd_named_old', ...precise });
    const anonYoung = await seedReport(5, { clientDraftId: 'd_anon_young', reporterDisplay: 'anonymous', ...precise });

    // recompute: a 100-day-old open report, one of them with stored exposure inputs
    const aged = await seedReport(100, { clientDraftId: 'd_aged_open' });
    const scoreBefore = aged.score;
    const exposed = await seedReport(100, { clientDraftId: 'd_aged_exposed' });
    store.exposure.set(exposed.id, { pedsPerDay: 1500, flags: { schoolRoute: true }, roadName: 'George Street', roadClass: 'tertiary', roadDistanceM: 3, sourceNote: 'estimated from map data' });
    expect(aged.score_terms.decay).toBe(0);

    // purgePhotos: pending 25 h → gone with its objects; pending 2 h → kept; attached 48 h → kept
    store.addPhoto({ id: 'ph_old', created_at: iso(NOW - 25 * HOUR_MS) });
    store.addPhoto({ id: 'ph_new', created_at: iso(NOW - 2 * HOUR_MS) });
    store.addPhoto({ id: 'ph_attached', report_id: aged.id, created_at: iso(NOW - 48 * HOUR_MS) });

    const res = await authed();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const body = await res.json();
    expect(body.skipped).toEqual([]);
    expect(body.ran.map((r: { name: string }) => r.name)).toEqual(JOBS.map((j) => j.name));
    for (const r of body.ran) expect(r).toMatchObject({ ok: true, done: true });
    expect(typeof body.tookMs).toBe('number');

    // autoVerify
    expect(stale.status).toBe('verified');
    const last = stale.events[stale.events.length - 1];
    expect(last).toMatchObject({ kind: 'auto_verified', actor_type: 'system', actor_id: null, from_status: 'completed', to_status: 'verified', note: AUTO_VERIFY_NOTE });
    expect(last.note).toBe('auto-verified after 14 days');
    expect(fresh.status).toBe('completed');
    expect(judged.status).toBe('completed');
    expect(body.ran.find((r: { name: string }) => r.name === 'autoVerify').processed).toBe(1);

    // coarsenGps
    const snapped = snapToGrid(precise, 50);
    expect(anonOld.lat).toBe(snapped.lat);
    expect(anonOld.lng).toBe(snapped.lng);
    expect(anonOld.public_lat).toBe(snapped.lat);
    expect(anonOld.public_lng).toBe(snapped.lng);
    expect(distanceM(anonOld, precise)).toBeLessThanOrEqual(36);
    expect(distanceM(anonOld, precise)).toBeGreaterThan(0);
    expect(namedOld.lat).toBe(precise.lat);
    expect(namedOld.lng).toBe(precise.lng);
    expect(anonYoung.lat).toBe(precise.lat);
    expect(anonYoung.lng).toBe(precise.lng);
    expect(body.ran.find((r: { name: string }) => r.name === 'coarsenGps').processed).toBe(1);

    // purgePhotos
    expect(store.photos.map((p) => p.id).sort()).toEqual(['ph_attached', 'ph_new']);
    expect(store.storage.has('photos/ph_old.jpg')).toBe(false);
    expect(store.storage.has('photos/ph_old.thumb.jpg')).toBe(false);
    expect(store.storage.has('photos/ph_new.jpg')).toBe(true);
    expect(body.ran.find((r: { name: string }) => r.name === 'purgePhotos').processed).toBe(1);

    // recompute: decay moved from 0 to 100/365, the other terms held, the score follows the formula
    expect(aged.score_terms.decay).toBeCloseTo(decayTerm(100), 6);
    expect(aged.score_terms.severity).toBe(0.5);
    expect(aged.score_terms.liability).toBe(0.9);
    expect(aged.score).toBe(scoreFromTerms(aged.score_terms));
    expect(aged.score).toBeGreaterThan(scoreBefore);
    expect(exposed.score_terms.exposure).toBeCloseTo(exposureTerm(1500, { schoolRoute: true }), 6);
    expect(exposed.score).toBe(scoreFromTerms(exposed.score_terms));
    // completed/verified rows are not open and were not touched by the recompute
    expect(stale.score_terms.decay).toBe(0);
    expect(aged.updated_at).toBe(iso(NOW));

    // job_run bookkeeping
    for (const j of JOBS) {
      const run = store.runs.get(j.name)!;
      expect(run).toMatchObject({ ok: true, cursor: null, error: null, last_ok_at: iso(NOW) });
      expect(run.started_at).toBe(iso(NOW));
      expect(run.finished_at).toBe(iso(NOW));
    }
  });

  test('a second tick the same morning skips every job as not due', async () => {
    await seedReport(100);
    expect((await (await authed()).json()).ran).toHaveLength(JOBS.length);
    const second = await (await authed()).json();
    expect(second.ran).toEqual([]);
    expect(second.skipped).toEqual(JOBS.map((j) => ({ name: j.name, reason: 'not_due' })));
  });
});

describe('dispatcher', () => {
  test('nightly boundary is the latest 02:00 America/New_York at or before now', () => {
    for (const now of [NOW, NOW + 5 * HOUR_MS, NOW + 17 * HOUR_MS + 59 * 60_000, Date.parse('2026-01-15T06:30:00.000Z')]) {
      const b = latestNightlyBoundary(now);
      expect(b).toBeLessThanOrEqual(now);
      expect(now - b).toBeLessThan(DAY_MS);
      expect(localMinutes(b)).toBe(NIGHTLY_LOCAL_MINUTES);
    }
  });

  test('dueState: never ran → due; success before the boundary → due; after it → not due; a cursor resumes; intervals elapse', () => {
    const nightly = JOBS.find((j) => j.name === 'recompute')!;
    const every = JOBS.find((j) => j.name === 'pushReceipts')!;
    const run = (over: Partial<JobRunRow>): JobRunRow => ({ name: nightly.name, started_at: null, finished_at: null, ok: null, cursor: null, error: null, last_ok_at: null, ...over });
    const boundary = latestNightlyBoundary(NOW);
    expect(dueState(nightly, undefined, NOW)).toBeNull();
    expect(dueState(nightly, run({ ok: true, last_ok_at: iso(boundary - 60_000), finished_at: iso(boundary - 60_000) }), NOW)).toBeNull();
    expect(dueState(nightly, run({ ok: true, last_ok_at: iso(boundary + 60_000), finished_at: iso(boundary + 60_000) }), NOW)).toBe('not_due');
    expect(dueState(nightly, run({ ok: true, last_ok_at: iso(NOW - 10 * DAY_MS), finished_at: iso(NOW - 60_000), cursor: { created_at: 'x', id: 'y' } }), NOW)).toBeNull();
    expect(dueState(every, run({ name: 'pushReceipts', ok: true, last_ok_at: iso(NOW - 14 * 60_000), finished_at: iso(NOW - 14 * 60_000) }), NOW)).toBe('not_due');
    expect(dueState(every, run({ name: 'pushReceipts', ok: true, last_ok_at: iso(NOW - 16 * 60_000), finished_at: iso(NOW - 16 * 60_000) }), NOW)).toBeNull();
    // a run started 30 s ago and not finished belongs to another caller; one started 5 min ago is a dead lease
    expect(dueState(nightly, run({ started_at: iso(NOW - 30_000) }), NOW)).toBe('running');
    expect(dueState(nightly, run({ started_at: iso(NOW - 5 * 60_000) }), NOW)).toBeNull();
    // microsecond timestamps from Postgres parse
    expect(dueState(nightly, run({ ok: true, last_ok_at: '2026-10-05T11:50:00.123456+00:00', finished_at: '2026-10-05T11:50:00.123456+00:00' }), NOW)).toBe('not_due');
  });

  test('a tick with no time left starts nothing and says so', async () => {
    const result = await tick({ store, deadline: NOW });
    expect(result.ran).toEqual([]);
    expect(result.skipped).toEqual(JOBS.map((j) => ({ name: j.name, reason: 'deadline' })));
    expect(store.runs.size).toBe(0);
  });

  test('a failing job records the error, keeps last_ok_at, and waits before retrying while the others run', async () => {
    await store.saveRun({ name: 'autoVerify', started_at: null, finished_at: null, ok: true, cursor: null, error: null, last_ok_at: iso(NOW - 2 * DAY_MS) });
    const failing = jest.spyOn(store, 'completedBefore').mockRejectedValue(new Error('db down'));
    const first = await tick({ store });
    const failed = first.ran.find((r) => r.name === 'autoVerify')!;
    expect(failed).toMatchObject({ ok: false, done: false, error: 'db down' });
    expect(first.ran.filter((r) => r.ok)).toHaveLength(JOBS.length - 1);
    expect(store.runs.get('autoVerify')).toMatchObject({ ok: false, error: 'db down', last_ok_at: iso(NOW - 2 * DAY_MS), finished_at: iso(NOW) });
    failing.mockRestore();
    const second = await tick({ store });
    expect(second.skipped).toContainEqual({ name: 'autoVerify', reason: 'retry_wait' });
  });
});
