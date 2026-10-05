/**
 * services/engagement — the phone side of votes, follows and comments (plan §9.2 mutations queue): sign-in asked
 * first (null → nothing happens), optimistic store state, offline → queued (toggles cancel out), online → reconciled
 * from the server's answer, and flushMutations() replays in order, removing on 2xx/409, rolling back and dropping on
 * 4xx, stopping on 5xx/network/401. Demo reports toggle locally and never touch the network.
 */
import { mutationsRepo } from '@/data/repos';
import { buildDemoReports } from '@/domain/demo';
import { PILOT } from '@/domain/pilot';
import type { AuthSession, PublicReport, VoteResponse } from '@/domain/types';
import { applyDemoScenario } from '@/services/demo';
import { comment, fateOf, flag, flushMutations, follow, vote } from '@/services/engagement';
import { actions, getState, hydrate, setState } from '@/store/appStore';

jest.mock('expo-notifications', () => ({ getPermissionsAsync: jest.fn(async () => ({ granted: false })), requestPermissionsAsync: jest.fn(async () => ({ granted: false })) }));

const SESSION: AuthSession = { userId: 'u_jane', role: 'resident', displayName: 'Jane Doe', email: null, provider: 'apple' };
const REPORT: PublicReport = { ...buildDemoReports('calm', PILOT.center)[0], id: 'rc_000001', isDemo: false, voteCount: 5, commentCount: 2 };
const VOTE_OK: VoteResponse = { reportId: REPORT.id, voteCount: 7, voted: true, score: 61, scoreTerms: { ...REPORT.scoreTerms, community: 0.3 } };

type Reply = { status: number; body?: unknown };
let replies: ((url: string, method: string) => Reply | undefined)[] = [];
const calls: { url: string; method: string; body: unknown }[] = [];

const fetchSpy = jest.spyOn(globalThis, 'fetch' as never).mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
  let reply: Reply | undefined;
  for (const r of replies) reply = reply ?? r(url, method);
  if (!reply) reply = { status: 500, body: { error: { code: 'internal', message: 'unexpected' } } };
  return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
}) as never);

const online = () => setState({ network: { online: true, type: 'WIFI' } });
const offline = () => setState({ network: { online: false, type: 'NONE' } });
const feedReport = () => getState().feed.find((r) => r.id === REPORT.id)!;
const queueKinds = () => mutationsRepo.getAll().map((m) => m.kind);

beforeEach(() => {
  actions.resetAll();
  hydrate();
  applyDemoScenario(null);
  actions.setFeed([REPORT]);
  setState({ session: SESSION, location: null });
  offline();
  replies = [];
  calls.length = 0;
});

afterAll(() => fetchSpy.mockRestore());

describe('sign-in required', () => {
  test('signed out: nothing changes, nothing is queued, nothing is sent', async () => {
    setState({ session: null });
    expect(await vote(REPORT.id, true)).toEqual({ ok: false, reason: 'sign_in', message: 'Sign in to continue.' });
    expect(await follow(REPORT.id, true)).toMatchObject({ ok: false, reason: 'sign_in' });
    expect(await comment(REPORT.id, 'Still there')).toMatchObject({ ok: false, reason: 'sign_in' });
    online();
    expect(await flag({ type: 'report', id: REPORT.id }, 'spam')).toMatchObject({ ok: false, reason: 'sign_in' });
    expect(getState().votedIds).toEqual([]);
    expect(getState().followedIds).toEqual([]);
    expect(queueKinds()).toEqual([]);
    expect(feedReport().voteCount).toBe(5);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('the comment filter runs before the sign-in ask', async () => {
    setState({ session: null });
    expect(await comment(REPORT.id, 'see https://spam.example.com')).toMatchObject({ ok: false, reason: 'rejected', message: expect.stringMatching(/Links/) });
  });
});

describe('offline: optimistic state + queue', () => {
  test('a vote flips votedIds and the cached count and queues one mutation; toggling again replaces it', async () => {
    expect(await vote(REPORT.id, true)).toEqual({ ok: true, queued: true });
    expect(getState().votedIds).toEqual([REPORT.id]);
    expect(feedReport().voteCount).toBe(6);
    expect(queueKinds()).toEqual(['vote']);

    expect(await vote(REPORT.id, false)).toEqual({ ok: true, queued: true });
    expect(getState().votedIds).toEqual([]);
    expect(feedReport().voteCount).toBe(5);
    expect(queueKinds()).toEqual(['unvote']);

    await vote(REPORT.id, true);
    expect(queueKinds()).toEqual(['vote']);
    expect(await vote(REPORT.id, true)).toEqual({ ok: true, queued: false }); // already voted: no-op
    expect(queueKinds()).toEqual(['vote']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('follow and comment queue too; the comment bumps the count and keeps its order after the vote', async () => {
    await vote(REPORT.id, true);
    expect(await follow(REPORT.id, true)).toEqual({ ok: true, queued: true });
    expect(getState().followedIds).toEqual([REPORT.id]);
    expect(await comment(REPORT.id, 'Still there this morning')).toEqual({ ok: true, queued: true, comment: null });
    expect(feedReport().commentCount).toBe(3);
    expect(queueKinds()).toEqual(['vote', 'follow', 'comment']);
    expect(mutationsRepo.getAll()[2]).toMatchObject({ kind: 'comment', reportId: REPORT.id, body: 'Still there this morning' });
    expect(await flag({ type: 'report', id: REPORT.id }, 'spam')).toMatchObject({ ok: false, reason: 'offline' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('flushMutations offline skips everything and keeps the queue', async () => {
    await vote(REPORT.id, true);
    expect(await flushMutations()).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(queueKinds()).toEqual(['vote']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('flushMutations online', () => {
  test('replays in order, removes on 2xx and reconciles the store from the answers', async () => {
    await vote(REPORT.id, true);
    await follow(REPORT.id, true);
    await comment(REPORT.id, 'Still there this morning');
    online();
    replies = [
      (url, method) => (url.endsWith('/votes') && method === 'POST' ? { status: 201, body: VOTE_OK } : undefined),
      (url, method) => (url.endsWith('/follow') && method === 'POST' ? { status: 201, body: { reportId: REPORT.id, following: true } } : undefined),
      (url, method) => (url.endsWith('/comments') && method === 'POST' ? { status: 201, body: { comment: { id: 'cm_1', body: 'Still there this morning', authorDisplay: 'J.D.', isStaff: false, at: '2026-10-05T12:00:00.000Z' } } } : undefined),
    ];
    expect(await flushMutations()).toEqual({ sent: 3, failed: 0, skipped: 0 });
    expect(queueKinds()).toEqual([]);
    expect(calls.map((c) => [c.method, c.url.replace(/^.*\/api/, '/api')])).toEqual([
      ['POST', `/api/v1/reports/${REPORT.id}/votes`],
      ['POST', `/api/v1/reports/${REPORT.id}/follow`],
      ['POST', `/api/v1/reports/${REPORT.id}/comments`],
    ]);
    expect(calls[2].body).toEqual({ body: 'Still there this morning' });
    expect(getState().votedIds).toEqual([REPORT.id]);
    expect(getState().followedIds).toEqual([REPORT.id]);
    expect(feedReport()).toMatchObject({ voteCount: 7, score: 61, scoreTerms: VOTE_OK.scoreTerms });
  });

  test('409 counts as done (the server already has the vote); 4xx drops the mutation and rolls the optimistic change back', async () => {
    await vote(REPORT.id, true);
    await follow(REPORT.id, true);
    online();
    replies = [
      (url) => (url.endsWith('/votes') ? { status: 409, body: { error: { code: 'conflict', message: 'already' } } } : undefined),
      (url) => (url.endsWith('/follow') ? { status: 403, body: { error: { code: 'forbidden', message: 'no' } } } : undefined),
    ];
    expect(await flushMutations()).toEqual({ sent: 1, failed: 1, skipped: 0 });
    expect(queueKinds()).toEqual([]);
    expect(getState().votedIds).toEqual([REPORT.id]);
    expect(getState().followedIds).toEqual([]);
  });

  test('5xx and network errors stop the run and keep the rest; 401 stops too', async () => {
    await vote(REPORT.id, true);
    await follow(REPORT.id, true);
    online();
    replies = [() => ({ status: 503, body: { error: { code: 'misconfigured', message: 'later' } } })];
    expect(await flushMutations()).toEqual({ sent: 0, failed: 0, skipped: 2 });
    expect(queueKinds()).toEqual(['vote', 'follow']);
    expect(calls).toHaveLength(1);
    expect(getState().votedIds).toEqual([REPORT.id]);

    calls.length = 0;
    replies = [() => ({ status: 401, body: { error: { code: 'unauthenticated', message: 'expired' } } })];
    expect(await flushMutations()).toEqual({ sent: 0, failed: 0, skipped: 2 });
    expect(queueKinds()).toEqual(['vote', 'follow']);
    expect(calls).toHaveLength(1);
  });

  test('fateOf classifies answers by the drafts’ retry policy', () => {
    const r = (status: number, ok = false) => (ok ? { ok: true as const, status, data: {} } : { ok: false as const, status, code: 'x', message: 'x', retryAfterMs: null });
    expect(fateOf(r(201, true))).toBe('done');
    expect(fateOf(r(409))).toBe('done');
    expect(fateOf(r(401))).toBe('sign_in');
    for (const s of [0, 408, 429, 500, 502, 503]) expect(fateOf(r(s))).toBe('retry');
    for (const s of [400, 403, 404, 422, 501]) expect(fateOf(r(s))).toBe('fail');
  });
});

describe('online actions', () => {
  test('a vote posts the device fix, reconciles count and score from VoteResponse, and sends nothing when the server already has it', async () => {
    online();
    setState({ location: { lat: 40.49, lng: -74.45, accuracyM: 10, at: Date.now() } });
    replies = [(url, method) => (url.endsWith('/votes') && method === 'POST' ? { status: 201, body: VOTE_OK } : undefined)];
    expect(await vote(REPORT.id, true)).toEqual({ ok: true, queued: false });
    expect(calls[0]).toMatchObject({ method: 'POST', body: { lat: 40.49, lng: -74.45 } });
    expect(getState().votedIds).toEqual([REPORT.id]);
    expect(feedReport()).toMatchObject({ voteCount: 7, score: 61 });
    expect(queueKinds()).toEqual([]);
  });

  test('a transient failure keeps the optimistic state and queues; a 4xx rolls back and reports the reason', async () => {
    online();
    replies = [() => ({ status: 0 })];
    fetchSpy.mockImplementationOnce((async () => {
      throw new TypeError('Network request failed');
    }) as never);
    expect(await vote(REPORT.id, true)).toEqual({ ok: true, queued: true });
    expect(getState().votedIds).toEqual([REPORT.id]);
    expect(queueKinds()).toEqual(['vote']);

    mutationsRepo.remove(mutationsRepo.getAll()[0].id);
    replies = [() => ({ status: 429, body: { error: { code: 'rate_limited', message: 'slow down' } } })];
    const res = await vote(REPORT.id, false);
    expect(res).toEqual({ ok: true, queued: true }); // 429 is retried later, the optimistic unvote stands
    expect(queueKinds()).toEqual(['unvote']);
    mutationsRepo.remove(mutationsRepo.getAll()[0].id);
    actions.setVoted(REPORT.id, false);

    replies = [() => ({ status: 404, body: { error: { code: 'not_found', message: 'No such report.' } } })];
    expect(await vote(REPORT.id, true)).toEqual({ ok: false, reason: 'rejected', message: 'No such report.' });
    expect(getState().votedIds).toEqual([]);
    expect(feedReport().voteCount).toBe(5);
    expect(queueKinds()).toEqual([]);
  });

  test('a comment returns the server’s comment; a follow reconciles; a flag posts the reason and note', async () => {
    online();
    replies = [
      (url, method) => (url.endsWith('/comments') && method === 'POST' ? { status: 201, body: { comment: { id: 'cm_1', body: 'Still there', authorDisplay: 'J.D.', isStaff: false, at: '2026-10-05T12:00:00.000Z' } } } : undefined),
      (url, method) => (url.endsWith('/follow') && method === 'DELETE' ? { status: 200, body: { reportId: REPORT.id, following: false } } : undefined),
      (url) => (url.endsWith('/flag') ? { status: 201, body: { flagId: 'cf_1', status: 'open' } } : undefined),
    ];
    const c = await comment(REPORT.id, 'Still there');
    expect(c).toMatchObject({ ok: true, queued: false, comment: { id: 'cm_1', authorDisplay: 'J.D.' } });
    expect(feedReport().commentCount).toBe(3);
    actions.setFollowed(REPORT.id, true);
    expect(await follow(REPORT.id, false)).toEqual({ ok: true, queued: false });
    expect(getState().followedIds).toEqual([]);
    expect(await flag({ type: 'comment', id: 'cm_1' }, 'abuse', ' rude ')).toEqual({ ok: true, queued: false });
    expect(calls[2]).toMatchObject({ method: 'POST', body: { reason: 'abuse', note: 'rude' } });
    expect(calls[2].url).toMatch(/\/api\/v1\/comments\/cm_1\/flag$/);
  });
});

describe('demo reports', () => {
  test('toggle locally, are labelled, and never reach the network or the queue', async () => {
    applyDemoScenario('calm');
    online();
    const demo = getState().demoReports[0];
    expect(await vote(demo.id, true)).toEqual({ ok: true, queued: false });
    expect(getState().votedIds).toEqual([demo.id]);
    expect(getState().demoReports[0].voteCount).toBe(demo.voteCount + 1);
    expect(getState().demoReports[0].isDemo).toBe(true);
    expect(await follow(demo.id, true)).toEqual({ ok: true, queued: false });
    const c = await comment(demo.id, 'Demo comment');
    expect(c).toMatchObject({ ok: true, queued: false, comment: { body: 'Demo comment', authorDisplay: 'Jane Doe' } });
    expect(queueKinds()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getState().feed.some((r) => r.isDemo)).toBe(false); // demo data never lands in the feed cache
  });
});
