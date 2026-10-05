/**
 * S-08 detail wiring and the /r/[id] share page (spec R7; plan §9.2, §23.J): the comments composer renders; a vote
 * while signed out asks to sign in without a request; with a fake session and fetch mocked the follow button flips
 * optimistically and the request goes out; comments load from GET and a sent comment appears; the reporter's note
 * shows when present; the flag flow posts a reason; the public page renders a fetched report with the app link.
 */
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import PublicReportPage from '@/app/r/[id]';
import ReportDetailScreen from '@/app/report/[id]';
import { buildDemoReports } from '@/domain/demo';
import { PILOT } from '@/domain/pilot';
import type { AuthSession, PublicReport } from '@/domain/types';
import { applyDemoScenario } from '@/services/demo';
import { actions, getState, hydrate, setState } from '@/store/appStore';

jest.mock('expo-notifications', () => ({ getPermissionsAsync: jest.fn(async () => ({ granted: false })), requestPermissionsAsync: jest.fn(async () => ({ granted: false })) }));

const routes = {
  index: () => null,
  'report/[id]': ReportDetailScreen,
  'r/[id]': PublicReportPage,
};

const SESSION: AuthSession = { userId: 'u_jane', role: 'resident', displayName: 'Jane Doe', email: null, provider: 'apple' };
const LIVE: PublicReport = { ...buildDemoReports('calm', PILOT.center)[0], id: 'rc_000001', isDemo: false, voteCount: 5, commentCount: 1, summary: 'Lifted panel by the bus stop' };
const COMMENT = { id: 'cm_1', body: 'Still there this morning', authorDisplay: 'B.S.', isStaff: false, at: '2026-10-05T12:00:00.000Z' };

type Reply = { status: number; body: unknown };
let replies: ((url: string, method: string) => Reply | undefined)[] = [];
const calls: { url: string; method: string; body: unknown }[] = [];

const fetchSpy = jest.spyOn(globalThis, 'fetch' as never).mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
  let reply: Reply | undefined;
  for (const r of replies) reply = reply ?? r(url, method);
  if (!reply) reply = { status: 404, body: { error: { code: 'not_found', message: 'No such report.' } } };
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
}) as never);

async function press(el: ReturnType<typeof screen.getByText>) {
  await act(async () => {
    fireEvent.press(el);
  });
}

beforeEach(() => {
  actions.resetAll();
  hydrate();
  applyDemoScenario('calm');
  setState({ network: { online: false, type: 'NONE' }, locationStatus: 'denied', location: null, session: null });
  actions.savePrefs({ ...getState().prefs, home: { ...PILOT.center, radiusM: 400 } }, { finishOnboarding: true });
  replies = [];
  calls.length = 0;
  fetchSpy.mockClear();
});

afterAll(() => fetchSpy.mockRestore());

describe('S-08 detail, offline and signed out (demo)', () => {
  test('renders the comments composer, the vote meter and the flag cell with zero requests', async () => {
    const first = buildDemoReports('calm', PILOT.center)[0];
    await renderRouter(routes, { initialUrl: `/report/${first.id}` });
    expect(await screen.findByText(first.title)).toBeTruthy();
    expect(screen.getByTestId('comment-input')).toBeTruthy();
    expect(screen.getByText('Send')).toBeTruthy();
    expect(screen.getByText('Neighbours')).toBeTruthy();
    expect(screen.getByText('No comments yet')).toBeTruthy();
    expect(screen.getByText('Follow this order')).toBeTruthy();
    expect(screen.getByText('Report a problem with this post')).toBeTruthy();
    expect(screen.getByText(/votes needed for supervisor review|threshold passed/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('voting while signed out asks to sign in; nothing is sent or queued', async () => {
    const first = buildDemoReports('calm', PILOT.center)[0];
    await renderRouter(routes, { initialUrl: `/report/${first.id}` });
    await screen.findByText(first.title);
    await press(screen.getByTestId('vote'));
    expect(await screen.findByText('Sign in to vote')).toBeTruthy();
    expect(getState().votedIds).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a signed-in resident votes on a demo report optimistically, offline, with no request', async () => {
    setState({ session: SESSION });
    const first = buildDemoReports('calm', PILOT.center)[0];
    await renderRouter(routes, { initialUrl: `/report/${first.id}` });
    await screen.findByText(first.title);
    await press(screen.getByTestId('vote'));
    expect(getState().votedIds).toEqual([first.id]);
    expect(await screen.findByLabelText(/you voted/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('S-08 detail, online with a fake session (live report)', () => {
  beforeEach(() => {
    applyDemoScenario(null);
    actions.setFeed([LIVE]);
    setState({ network: { online: true, type: 'WIFI' }, session: SESSION });
    replies = [
      (url, method) => (url.endsWith(`/reports/${LIVE.id}/comments`) && method === 'GET' ? { status: 200, body: { comments: [COMMENT] } } : undefined),
      (url, method) => (url.endsWith(`/reports/${LIVE.id}/comments`) && method === 'POST' ? { status: 201, body: { comment: { ...COMMENT, id: 'cm_2', body: 'Crew put a cone out today', authorDisplay: 'Jane Doe' } } } : undefined),
      (url, method) => (url.endsWith(`/reports/${LIVE.id}/follow`) && method === 'POST' ? { status: 201, body: { reportId: LIVE.id, following: true } } : undefined),
      (url, method) => (url.endsWith(`/reports/${LIVE.id}/flag`) && method === 'POST' ? { status: 201, body: { flagId: 'cf_1', status: 'open' } } : undefined),
    ];
  });

  test('loads comments from GET, shows the reporter’s note, and follow toggles optimistically then posts', async () => {
    await renderRouter(routes, { initialUrl: `/report/${LIVE.id}` });
    expect(await screen.findByText(LIVE.title)).toBeTruthy();
    expect(await screen.findByText('Still there this morning')).toBeTruthy();
    expect(screen.getByText(/^B\.S\./)).toBeTruthy();
    expect(screen.getByTestId('report-summary').props.children).toBe('Lifted panel by the bus stop');
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.url.replace(/^.*\/api/, '/api'))).toEqual([`/api/v1/reports/${LIVE.id}/comments`]);

    await press(screen.getByText('Follow this order'));
    expect(getState().followedIds).toEqual([LIVE.id]);
    expect(await screen.findByText('Following')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith(`/reports/${LIVE.id}/follow`))).toBe(true);
  });

  test('typing a comment and pressing Send posts it and appends the server’s copy', async () => {
    await renderRouter(routes, { initialUrl: `/report/${LIVE.id}` });
    await screen.findByText('Still there this morning');
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('comment-input'), 'Crew put a cone out today');
    });
    await press(screen.getByTestId('comment-send'));
    expect(await screen.findByText('Crew put a cone out today')).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/comments'));
    expect(post?.body).toEqual({ body: 'Crew put a cone out today' });
    expect(screen.getByTestId('comment-input').props.value).toBe('');
  });

  test('the flag cell opens a reason picker and posts the chosen reason', async () => {
    await renderRouter(routes, { initialUrl: `/report/${LIVE.id}` });
    await screen.findByText(LIVE.title);
    await press(screen.getByTestId('flag-toggle'));
    await press(screen.getByText('Wrong place'));
    await press(screen.getByTestId('flag-send'));
    expect(await screen.findByText(/a moderator will look at this post/)).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/flag'));
    expect(post?.body).toEqual({ reason: 'wrong_place' });
  });

  test('a deep link to a report missing from the cache fetches it once', async () => {
    actions.setFeed([]);
    replies.unshift((url, method) => (url.endsWith(`/reports/${LIVE.id}`) && method === 'GET' ? { status: 200, body: { report: LIVE } } : undefined));
    await renderRouter(routes, { initialUrl: `/report/${LIVE.id}` });
    expect(await screen.findByText(LIVE.title)).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith(`/reports/${LIVE.id}`))).toHaveLength(1);
    expect(getState().feed.map((r) => r.id)).toEqual([LIVE.id]);
  });
});

describe('/r/[id] public share page', () => {
  test('fetches the public projection and renders it read-only with the app link', async () => {
    setState({ network: { online: true, type: 'WIFI' } });
    replies = [(url, method) => (url.endsWith(`/reports/${LIVE.id}`) && method === 'GET' ? { status: 200, body: { report: LIVE } } : undefined)];
    await renderRouter(routes, { initialUrl: `/r/${LIVE.id}` });
    expect(await screen.findByText(LIVE.title)).toBeTruthy();
    expect(screen.getByText('Open in RootCause')).toBeTruthy();
    expect(screen.getByText('Community votes')).toBeTruthy();
    expect(screen.getByText('Status timeline')).toBeTruthy();
    expect(screen.getByText(/OpenStreetMap contributors/)).toBeTruthy();
    expect(screen.queryByTestId('comment-input')).toBeNull();
  });

  test('says so when the report does not exist', async () => {
    setState({ network: { online: true, type: 'WIFI' } });
    await renderRouter(routes, { initialUrl: '/r/rc_nope' });
    expect(await screen.findByText('Report not found')).toBeTruthy();
  });
});
