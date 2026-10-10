/**
 * /api/v1/me/alerts and /api/v1/me/alerts/[id]/read against the memory repos (plan §14 route tests; §7 /me rows;
 * spec R8/R9): 401 without a session, 403 for an auditor · GET answers MyAlertListSchema — one row per alert whatever
 * the channels, newest first, the briefing body intact, nothing private — and delivers the inbox copies as it fetches
 * them · the read receipt is idempotent (200, 200), reflected in GET, and 404 for an alert the account never received
 * · the list stops at MY_ALERTS_LIMIT. The alerts repo resolves through the memory bundle, as the dev server does.
 */
import { GET as GET_ALERTS, MY_ALERTS_LIMIT } from '@/app/api/v1/me/alerts+api';
import { POST as POST_READ } from '@/app/api/v1/me/alerts/[id]/read+api';
import { MyAlertListSchema, type AlertBody } from '@/domain/types';
import { setTestUser } from '@/server/auth';
import { setLogSink } from '@/server/log';
import { getAlertsRepo, setAlertsRepo, type AlertRow } from '@/server/repos/alerts';
import { createMemoryRepos, type MemoryRepos } from '@/server/repos/memory';
import { setRepos } from '@/server/repos/types';

const BASE = 'http://localhost/api/v1/me/alerts';
const NOW = '2026-10-10T20:00:00.000Z';
const JANE = { id: 'u_jane', display_name: 'Jane Doe' };
const BOB = { id: 'u_bob', display_name: 'Bob Ray' };
/** Nothing private leaves through the inbox (plan §12): no account ids, tokens, geometry or install ids. */
const FORBIDDEN = /u_jane|u_bob|expo_push_token|ExponentPushToken|home_geom|install_id|user_id|phone/;

const get = () => GET_ALERTS(new Request(BASE));
const read = (id: string) => POST_READ(new Request(`${BASE}/${id}/read`, { method: 'POST' }), { id });

const body = (over: Partial<AlertBody> = {}): AlertBody => ({
  kind: 'warning',
  trigger: 'rain',
  title: 'Heavy rain from 9:30 PM — 52 mm · 3 open hazards sensitive to rain',
  body: 'Expect standing water at George St & Bayard St, Hamilton St and Sandford St after dark. Take the other side of the street there.',
  why: 'Your watch area is within 400 m of one or more of the 3 open hazards sensitive to rain.',
  spots: [{ reportId: 'rc_000001', title: 'Blocked tree-pit drain', line: 'George St & Bayard St · 38 days open · Blocked tree-pit drain', distanceM: null }],
  cityAction: 'The same list went to DPW as a pre-storm work list.',
  validFrom: '2026-10-11T01:30:00.000Z',
  validTo: '2026-10-11T07:30:00.000Z',
  forecast: { source: 'NWS gridpoint forecast', issuedAt: NOW, rainMm6h: 52, popPct: 84, gustKmh: 40, tempMinC: null },
  ...over,
});

let repos: MemoryRepos;
let seq = 0;

/** One alert with its deliveries (inbox for everyone, push for those named). */
async function seedAlert(users: string[], opts: { push?: string[]; createdAt?: string; body?: Partial<AlertBody> } = {}): Promise<AlertRow> {
  const createdAt = opts.createdAt ?? new Date(Date.parse(NOW) - ++seq * 60_000).toISOString();
  const alert = await repos.alerts.createAlert({ scenario_run_id: null, severity: 'warning', channel_mix: { push: true, inbox: true }, audience_query: {}, hazard_ids: ['rc_000001'], forecast_snapshot: null, body: body(opts.body), scheduled_for: createdAt, sent_at: createdAt, created_at: createdAt });
  await repos.alerts.insertDeliveries([...users.map((user_id) => ({ alert_id: alert.id, user_id, channel: 'inbox' as const, created_at: createdAt })), ...(opts.push ?? []).map((user_id) => ({ alert_id: alert.id, user_id, channel: 'push' as const, created_at: createdAt }))]);
  return alert;
}

beforeAll(() => setLogSink(() => {}));
afterAll(() => {
  setLogSink(null);
  setRepos(null);
  setAlertsRepo(null);
  setTestUser(undefined);
});

beforeEach(() => {
  repos = createMemoryRepos();
  repos.users.seed(JANE);
  repos.users.seed(BOB);
  setRepos(repos);
  setTestUser({ userId: JANE.id, role: 'resident' });
  seq = 0;
});

describe('sessions and capabilities', () => {
  test('401 without a session on both routes', async () => {
    setTestUser(null);
    let res = await get();
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
    res = await read('al_000001');
    expect(res.status).toBe(401);
  });

  test('an auditor reads everything and receives nothing: 403', async () => {
    setTestUser({ userId: JANE.id, role: 'auditor' });
    expect((await get()).status).toBe(403);
    expect((await read('al_000001')).status).toBe(403);
  });

  test('the alerts repo resolves through the memory bundle without a second override (dev-memory server path)', () => {
    expect(getAlertsRepo()).toBe(repos.alerts);
  });
});

describe('GET /api/v1/me/alerts', () => {
  test('empty inbox is an empty list, not an error', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ alerts: [] });
  });

  test('one row per alert (inbox + push deduplicated), newest first, briefing intact, nothing private; inbox copies become delivered', async () => {
    const older = await seedAlert([JANE.id, BOB.id], { push: [JANE.id], createdAt: '2026-10-09T20:00:00.000Z', body: { title: 'Older advisory' } });
    const newer = await seedAlert([JANE.id], { push: [JANE.id], createdAt: '2026-10-10T19:00:00.000Z' });
    const bobsOnly = await seedAlert([BOB.id], { createdAt: '2026-10-10T19:30:00.000Z', body: { title: 'Not for Jane' } });
    const res = await get();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(FORBIDDEN);
    const parsed = MyAlertListSchema.parse(JSON.parse(text));
    expect(parsed.alerts.map((a) => a.id)).toEqual([newer.id, older.id]);
    expect(parsed.alerts.map((a) => a.id)).not.toContain(bobsOnly.id);
    expect(parsed.alerts[0]).toEqual({ id: newer.id, at: '2026-10-10T19:00:00.000Z', read: false, body: body() });
    expect(parsed.alerts[1].body.title).toBe('Older advisory');
    // the inbox rows were delivered by the fetch; the push rows stay queued for the dispatcher
    const janes = repos.alerts.deliveries.filter((d) => d.user_id === JANE.id);
    expect(janes.filter((d) => d.channel === 'inbox').every((d) => d.status === 'delivered' && d.sent_at !== null)).toBe(true);
    expect(janes.filter((d) => d.channel === 'push').every((d) => d.status === 'queued')).toBe(true);
    expect(repos.alerts.deliveries.filter((d) => d.user_id === BOB.id).every((d) => d.status === 'queued')).toBe(true);
  });

  test('stops at MY_ALERTS_LIMIT, keeping the newest', async () => {
    for (let i = 0; i < MY_ALERTS_LIMIT + 5; i++) await seedAlert([JANE.id]);
    const parsed = MyAlertListSchema.parse(await (await get()).json());
    expect(parsed.alerts).toHaveLength(MY_ALERTS_LIMIT);
    const ats = parsed.alerts.map((a) => a.at);
    expect([...ats].sort().reverse()).toEqual(ats);
  });
});

describe('POST /api/v1/me/alerts/[id]/read', () => {
  test('marks every delivery of the alert opened; replays answer 200 too; GET reflects it', async () => {
    const alert = await seedAlert([JANE.id, BOB.id], { push: [JANE.id] });
    let res = await read(alert.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ alertId: alert.id, read: true });
    const janes = repos.alerts.deliveries.filter((d) => d.user_id === JANE.id && d.alert_id === alert.id);
    expect(janes).toHaveLength(2);
    expect(janes.every((d) => d.opened_at !== null)).toBe(true);
    const firstOpened = janes[0].opened_at;
    res = await read(alert.id);
    expect(res.status).toBe(200);
    expect(janes[0].opened_at).toBe(firstOpened);
    // Bob's copy is untouched
    expect(repos.alerts.deliveries.find((d) => d.user_id === BOB.id && d.alert_id === alert.id)?.opened_at).toBeNull();
    const parsed = MyAlertListSchema.parse(await (await get()).json());
    expect(parsed.alerts[0]).toMatchObject({ id: alert.id, read: true });
  });

  test('404 for an unknown alert and for one the account never received', async () => {
    const bobs = await seedAlert([BOB.id]);
    expect((await read('al_999999')).status).toBe(404);
    const res = await read(bobs.id);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
    expect(repos.alerts.deliveries.find((d) => d.alert_id === bobs.id)?.opened_at).toBeNull();
  });
});
