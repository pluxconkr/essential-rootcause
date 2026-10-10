/**
 * The predictive-alert loop against the memory repos (plan §11 weatherPoll · scenarioEval · alertDispatch; §23.H;
 * spec §9, 4.2): the poll parses a saved NWS fixture (never the network) into one forecast row — the hour underway
 * included — and degrades honestly when a product is missing · the rain scenario fires on 52 mm and not on 10 mm,
 * builds a briefing that names the places and the storm's own window (the peak 6 h of the hourly series, never the
 * poll time; no series → no onset), writes the run, the alert and the deliveries once (12 h cooldown), and the
 * audience respects the watch area buffer, the category list, the fatigue budget and quiet hours · staleness counts
 * from the poll, not from the NWS issue time · wind and freeze rules fire on their facts · the dispatcher sends at
 * most DISPATCH_PER_TICK pushes per call and records the ticket ids · the storm multiplier is readable while a run is
 * active.
 */
import gridpointFixture from '../../__fixtures__/nws/gridpoint.json';
import hourlyFixture from '../../__fixtures__/nws/hourly.json';
import pointsFixture from '../../__fixtures__/nws/points.json';
import { ALERT_SPOTS_MAX, AUDIENCE_BUFFER_M, DEFAULT_SCENARIOS, FATIGUE_BUDGET, buildAlertBody, evaluateTrigger } from '@/domain/alerts';
import { PILOT } from '@/domain/pilot';
import { subtypeDef } from '@/domain/taxonomy';
import { DAY_MS } from '@/domain/time';
import type { CreateReportInput, Subtype } from '@/domain/types';
import { ENV_DEFAULTS } from '@/server/env';
import { ALERTS_CHANNEL, DISPATCH_PER_TICK, alertDispatch, dispatchQueuedPushes } from '@/server/jobs/alertDispatch';
import { activeStormMultiplier, evaluateScenarios, scenarioEval } from '@/server/jobs/scenarioEval';
import { FORECAST_HORIZON_H, NWS_API, hourlyRainMm, maxRollingSum, parseDurationMs, parseSpeedKmh, peakRainWindow, pollWeather, summarize, weatherPoll } from '@/server/jobs/weatherPoll';
import { setLogSink } from '@/server/log';
import { setPushSender, type ExpoPushMessage, type ExpoPushTicket } from '@/server/push';
import { setAlertsRepo, type ForecastInsert } from '@/server/repos/alerts';
import { createMemoryRepos, type MemoryRepos } from '@/server/repos/memory';
import { setRepos } from '@/server/repos/types';

const HOUR_MS = 3_600_000;
/** 2026-10-10 18:00Z = 2:00 PM EDT, the fixture's first hourly period. */
const NOW = Date.parse('2026-10-10T18:00:00.000Z');
/** New York wall-clock instants in EDT (UTC−4) on the fixture's date. */
const edt = (h: number) => Date.parse(`2026-10-10T${String((h + 4) % 24).padStart(2, '0')}:00:00Z`) + (h + 4 >= 24 ? DAY_MS : 0);
const iso = (ms: number) => new Date(ms).toISOString();
const token = (s: string) => `ExponentPushToken[${s}]`;
const ctx = (now = NOW) => ({ now, deadline: now + 18_000, requestId: 'test' });
const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let repos: MemoryRepos;
let draftSeq = 0;

/** A named open report at an offset (metres, roughly) from the pilot centre. */
async function seedReport(subtype: Subtype, address: string, opts: { ageDays?: number; eastM?: number; northM?: number; severity?: 1 | 2 | 3 } = {}) {
  const input: CreateReportInput = {
    clientDraftId: `d_${String(++draftSeq).padStart(4, '0')}_abcdefgh`,
    category: subtypeDef(subtype).category,
    subtype,
    severityResident: opts.severity ?? 2,
    injuryFlag: 'no',
    reporterDisplay: 'named',
    lat: PILOT.center.lat + (opts.northM ?? 0) / 111_320,
    lng: PILOT.center.lng + (opts.eastM ?? 0) / (111_320 * Math.cos((PILOT.center.lat * Math.PI) / 180)),
    accuracyM: 8,
    locationConfirmed: true,
    addressText: address,
    photoIds: [],
    capturedAt: iso(NOW),
  };
  const { row } = await repos.reports.create(input, { userId: 'u_jane', role: 'resident', now: iso(NOW - (opts.ageDays ?? 10) * DAY_MS), requestId: `seed-${draftSeq}` });
  return repos.reports.rows.find((r) => r.id === row.id)!;
}

function seedUser(id: string, opts: { eastM?: number; categories?: ('vegetation' | 'roadway' | 'sidewalk' | 'drainage' | 'lighting')[]; device?: boolean; quiet?: { start: string; end: string } } = {}) {
  repos.users.seed({ id, display_name: id });
  repos.alerts.seedWatchArea({ user_id: id, lat: PILOT.center.lat, lng: PILOT.center.lng + (opts.eastM ?? 0) / (111_320 * Math.cos((PILOT.center.lat * Math.PI) / 180)), radius_m: 400, categories: opts.categories ?? [] });
  if (opts.device) repos.alerts.seedDevice({ user_id: id, expo_push_token: token(id), platform: 'ios' });
  if (opts.quiet) repos.alerts.seedQuietHours(id, opts.quiet);
}

/** 52 mm in the hours 6–11 after the poll (8 PM–2 AM on NOW): the series the briefing's window is read from. */
const RAIN_BY_HOUR = [0, 0, 0, 0, 0, 0, 8, 8, 10, 10, 8, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const forecast = (over: Partial<ForecastInsert> = {}): ForecastInsert => ({ issued_at: iso(NOW - 30 * 60_000), valid_from: iso(NOW), valid_to: iso(NOW + 24 * HOUR_MS), grid_id: 'PHI/48,78', rain_mm: 52, pop_pct: 84, gust_kmh: 40, temp_min: 11, temp_max: 20, payload: { rainMmByHour: RAIN_BY_HOUR }, ...over });

let sent: ExpoPushMessage[][];
function fakeSender(reply: (m: ExpoPushMessage) => ExpoPushTicket = (m) => ({ status: 'ok', id: `t_${String(m.to)}` })) {
  sent = [];
  setPushSender({
    async send(chunkOfMessages) {
      sent.push(chunkOfMessages);
      return chunkOfMessages.map(reply);
    },
  });
}

/** fetch that answers the three NWS products from the fixtures (or a failure for the named ones; `hourly` swaps that product). */
function nwsFetch(fail: { points?: boolean; hourly?: boolean; grid?: boolean } = {}, hourly: unknown = hourlyFixture) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
    const reply = (ok: boolean, body: unknown) => new Response(ok ? JSON.stringify(body) : 'upstream error', { status: ok ? 200 : 500, headers: { 'content-type': 'application/geo+json' } });
    if (url.startsWith(`${NWS_API}/points/`)) return reply(!fail.points, pointsFixture);
    if (url.endsWith('/forecast/hourly')) return reply(!fail.hourly, hourly);
    if (url.endsWith('/gridpoints/PHI/48,78')) return reply(!fail.grid, gridpointFixture);
    return new Response('not found', { status: 404 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

beforeAll(() => {
  setLogSink(() => {});
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.SUPABASE_URL = 'https://test-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-for-tests';
});

afterAll(() => {
  setLogSink(null);
  setRepos(null);
  setAlertsRepo(null);
  setPushSender(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  repos = createMemoryRepos();
  repos.users.seed({ id: 'u_jane', display_name: 'Jane Doe' });
  setRepos(repos);
  setAlertsRepo(repos.alerts);
  draftSeq = 0;
  fakeSender();
});

describe('weatherPoll: NWS parsing', () => {
  test('units and intervals: mph → km/h, ISO-8601 durations, QPF spread by the hour, rolling 6 h maximum', () => {
    expect(parseSpeedKmh('20 mph')).toBeCloseTo(32.2, 1);
    expect(parseSpeedKmh('15 to 25 mph')).toBeCloseTo(40.2, 1);
    expect(parseSpeedKmh('32 km/h')).toBe(32);
    expect(parseSpeedKmh(null)).toBeNull();
    expect(parseSpeedKmh('calm')).toBeNull();
    expect(parseDurationMs('PT6H')).toBe(6 * HOUR_MS);
    expect(parseDurationMs('P1DT2H')).toBe(26 * HOUR_MS);
    expect(parseDurationMs('PT30M')).toBe(30 * 60_000);
    expect(parseDurationMs('nope')).toBe(0);
    const series = hourlyRainMm([{ validTime: `${iso(NOW)}/PT6H`, value: 12 }, { validTime: `${iso(NOW + 6 * HOUR_MS)}/PT2H`, value: 30 }], 'wmoUnit:mm', NOW, 12);
    expect(series.slice(0, 8)).toEqual([2, 2, 2, 2, 2, 2, 15, 15]);
    expect(series.slice(8)).toEqual([null, null, null, null]);
    expect(maxRollingSum(series, 6)).toBe(38); // 4 × 2 + 2 × 15, the window ending at hour 8
    expect(peakRainWindow(series, 6)).toEqual({ start: 2, mm: 38 }); // that window starts at hour 2
    expect(maxRollingSum([null, null], 6)).toBeNull();
    expect(peakRainWindow([null, null], 6)).toBeNull();
    expect(hourlyRainMm([{ validTime: `${iso(NOW)}/PT1H`, value: 1 }], 'wmoUnit:in', NOW, 2)[0]).toBeCloseTo(25.4, 6);
  });

  test('a poll minutes past the hour keeps the hour underway: bucket i is the clock hour nearest to from + i h, so the 6 h sum is not an hour short', () => {
    const block = [{ validTime: `${iso(NOW)}/PT6H`, value: 48 }];
    expect(hourlyRainMm(block, 'wmoUnit:mm', NOW + 7 * 60_000, 8)).toEqual([8, 8, 8, 8, 8, 8, null, null]);
    expect(maxRollingSum(hourlyRainMm(block, 'wmoUnit:mm', NOW + 7 * 60_000, 8), 6)).toBe(48);
    // more than half of the hour gone: the next clock hour is bucket 0, nothing is counted twice
    expect(hourlyRainMm(block, 'wmoUnit:mm', NOW + 37 * 60_000, 8)).toEqual([8, 8, 8, 8, 8, null, null, null]);
  });

  test('the fixture summarises to the largest 6 h rain, the peak chance, the peak gust and the °C range inside the 24 h horizon', () => {
    const hourly = { updated: null, periods: (hourlyFixture as unknown as { properties: { periods: never[] } }).properties.periods };
    const qpf = (gridpointFixture as unknown as { properties: { quantitativePrecipitation: { uom: string; values: never[] } } }).properties.quantitativePrecipitation;
    const s = summarize({ hourly, qpf }, NOW);
    expect(s.rainMm6h).toBeCloseTo(48.3, 1); // the 00–06Z block; the 2.5 mm day after the horizon is not counted
    expect(summarize({ hourly, qpf }, NOW + 7 * 60_000).rainMm6h).toBeCloseTo(48.3, 1); // a tick seven minutes past the hour sees the same block
    expect(s.popPct).toBe(85);
    expect(s.gustKmh).toBeCloseTo(25 * 1.609344, 1);
    expect(s.tempMinC).toBeCloseTo(((51 - 32) * 5) / 9, 1);
    expect(s.tempMaxC).toBeCloseTo(((68 - 32) * 5) / 9, 1);
    expect(FORECAST_HORIZON_H).toBe(24);
  });

  test('one poll stores one weather_forecast row from the three products, with the User-Agent and geo+json headers', async () => {
    const nws = nwsFetch();
    const { row, note } = await pollWeather(ctx(), { fetchFn: nws.fn });
    expect(row).not.toBeNull();
    expect(row).toMatchObject({ grid_id: 'PHI/48,78', pop_pct: 85, temp_min: expect.any(Number), temp_max: expect.any(Number), valid_from: iso(NOW), valid_to: iso(NOW + 24 * HOUR_MS), issued_at: '2026-10-10T17:13:00+00:00' });
    expect(row!.rain_mm).toBeCloseTo(48.3, 1);
    expect(row!.gust_kmh).toBeCloseTo(40.2, 1);
    expect(row!.payload).toMatchObject({ source: 'nws', products: { hourly: true, qpf: true } });
    expect(peakRainWindow(row!.payload.rainMmByHour as (number | null)[], 6)).toEqual({ start: 6, mm: 48.3 }); // the block starts 6 h after the poll: 8 PM
    expect((row!.payload.periods as unknown[]).length).toBeLessThanOrEqual(25);
    expect(note).toMatch(/PHI\/48,78: rain 48.3 mm\/6h, pop 85 %/);
    expect(nws.calls.map((c) => c.url)).toEqual([`${NWS_API}/points/40.4862,-74.4518`, 'https://api.weather.gov/gridpoints/PHI/48,78/forecast/hourly', 'https://api.weather.gov/gridpoints/PHI/48,78']);
    for (const c of nws.calls) expect(c.headers).toMatchObject({ 'user-agent': ENV_DEFAULTS.nwsUserAgent, accept: 'application/geo+json' });
    expect(repos.alerts.forecasts).toHaveLength(1);
  });

  test('a missing gridpoint product stores pop and gusts with rain_mm null — never a 0; a dead NWS stores nothing and does not throw', async () => {
    const noGrid = await pollWeather(ctx(), { fetchFn: nwsFetch({ grid: true }).fn });
    expect(noGrid.row).toMatchObject({ rain_mm: null, pop_pct: 85 });
    expect(noGrid.row!.payload).toMatchObject({ products: { hourly: true, qpf: false }, rainMmByHour: null });
    const noHourly = await pollWeather(ctx(), { fetchFn: nwsFetch({ hourly: true }).fn });
    expect(noHourly.row).toMatchObject({ pop_pct: null, gust_kmh: null, temp_min: null });
    expect(noHourly.row!.rain_mm).toBeCloseTo(48.3, 1);
    const dead = await pollWeather(ctx(), { fetchFn: nwsFetch({ points: true }).fn });
    expect(dead.row).toBeNull();
    expect(dead.note).toMatch(/nws unavailable/);
    expect(repos.alerts.forecasts).toHaveLength(2);
    // the JobFn never throws past the dispatcher either: a network failure is a completed run with nothing processed
    const spy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'));
    try {
      expect(await weatherPoll({ ...ctx(), store: repos.jobsStore, cursor: null })).toMatchObject({ done: true, processed: 0, note: expect.stringMatching(/nws unavailable/) });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('domain/alerts: rules and copy', () => {
  test('evaluateTrigger follows the spec shape: all/any, forecast facts, asset tags, report fields; a missing fact never fires', () => {
    const rain = DEFAULT_SCENARIOS.find((s) => s.kind === 'rain')!.trigger_expr;
    const facts = { rainMm6h: 52, popPct: 84, gustKmh: 40, tempMinC: 11, tempMaxC: 20 };
    const report = { category: 'drainage', open_days: 40, tags: ['rain', 'freeze'] };
    expect(evaluateTrigger(rain, { forecast: facts, report })).toBe(true);
    expect(evaluateTrigger(rain, { forecast: { ...facts, rainMm6h: 10 }, report })).toBe(false);
    expect(evaluateTrigger(rain, { forecast: { ...facts, popPct: 50 }, report })).toBe(false);
    expect(evaluateTrigger(rain, { forecast: { ...facts, rainMm6h: null }, report })).toBe(false);
    expect(evaluateTrigger(rain, { forecast: facts, report: { ...report, tags: ['wind'] } })).toBe(false);
    expect(evaluateTrigger(rain, { forecast: facts })).toBe(false);
    expect(evaluateTrigger({ any: [{ 'report.category': 'roadway', 'report.open_days': { gte: 30 } }, { 'asset.tag': 'wind' }] }, { forecast: facts, report: { category: 'roadway', open_days: 31, tags: [] } })).toBe(true);
    expect(evaluateTrigger({ any: [{ 'report.category': 'roadway', 'report.open_days': { gte: 30 } }] }, { forecast: facts, report: { category: 'roadway', open_days: 12, tags: [] } })).toBe(false);
    expect(evaluateTrigger({ 'forecast.nonsense': { gte: 1 } }, { forecast: facts })).toBe(false);
    expect(evaluateTrigger(null, { forecast: facts })).toBe(false);
    expect(evaluateTrigger({ all: [] }, { forecast: facts })).toBe(false);
  });

  test('buildAlertBody names the weather and the count, up to three places and a behaviour change, why, the spots and the city action', () => {
    const spots = ['George St & Bayard St', 'Hamilton St, 200–400 block', 'Sandford St & Baldwin St', '118 Livingston Ave', '40 Townsend St', '52 Easton Ave'].map((address, i) => ({ reportId: `rc_${i}`, title: 'Ponding', address, subtype: 'ponding' as const, createdAt: iso(NOW - (i + 1) * 3 * DAY_MS) }));
    const b = buildAlertBody({ kind: 'rain', severity: 'warning', forecast: { source: 'NWS gridpoint forecast', issuedAt: iso(NOW), rainMm6h: 52, popPct: 84, gustKmh: 40, tempMinC: null }, validFrom: iso(edt(21) + 30 * 60_000), validTo: iso(edt(21) + 390 * 60_000), spots, hazardCount: spots.length, now: NOW });
    expect(b.title).toBe('Heavy rain from 9:30 PM — 52 mm · 6 open hazards sensitive to rain');
    expect(b.body).toBe('Expect standing water at George St & Bayard St, Hamilton St, 200–400 block and Sandford St & Baldwin St after dark. Take the other side of the street there and report new ponding from the Map tab.');
    expect(b.why).toMatch(/within 400 m of one or more of the 6 open hazards sensitive to rain/);
    expect(b.spots).toHaveLength(ALERT_SPOTS_MAX);
    expect(b.spots[0]).toEqual({ reportId: 'rc_0', title: 'Ponding', line: 'George St & Bayard St · 3 days open · Standing water / chronic ponding', distanceM: null });
    expect(b.cityAction).toBe('The same list went to DPW as a pre-storm work list.');
    expect(b.kind).toBe('warning');
    expect(b.trigger).toBe('rain');
    expect(b.body.toLowerCase()).not.toContain('be careful');
    const wind = buildAlertBody({ kind: 'wind', severity: 'advisory', forecast: { source: 'x', issuedAt: iso(NOW), rainMm6h: null, popPct: null, gustKmh: 65, tempMinC: null }, validFrom: null, validTo: null, spots: [spots[5]], hazardCount: 1, now: NOW });
    expect(wind.title).toBe('High wind — gusts to 65 km/h · 1 open hazard sensitive to wind');
    expect(wind.body).toMatch(/Limbs over the walkway at 52 Easton Ave/);
    const freeze = buildAlertBody({ kind: 'freeze', severity: 'advisory', forecast: { source: 'x', issuedAt: iso(NOW), rainMm6h: null, popPct: null, gustKmh: null, tempMinC: -4 }, validFrom: null, validTo: null, spots: [], hazardCount: 0, now: NOW });
    expect(freeze.title).toBe('Freeze–thaw — low -4 °C · 0 open hazards sensitive to freeze–thaw');
    expect(freeze.body).toMatch(/Ice forms on the lips and panels at the spots listed below/);
  });
});

describe('scenarioEval', () => {
  let drain: Awaited<ReturnType<typeof seedReport>>;
  let cluster: Awaited<ReturnType<typeof seedReport>>;
  let ponding: Awaited<ReturnType<typeof seedReport>>;
  let limb: Awaited<ReturnType<typeof seedReport>>;

  beforeEach(async () => {
    drain = await seedReport('blocked_tree_pit_drain', 'George St & Bayard St', { ageDays: 38, eastM: 120, severity: 2 });
    cluster = await seedReport('pothole_cluster', 'Hamilton St, 200–400 block', { ageDays: 174, northM: 200, severity: 3 });
    ponding = await seedReport('ponding', 'Sandford St & Baldwin St', { ageDays: 210, eastM: -150, severity: 2 });
    limb = await seedReport('hanging_limb', '52 Easton Ave', { ageDays: 61, northM: -100, severity: 3 });
    await seedReport('lamp_out', 'French St rail underpass', { ageDays: 88 });
    // a rain-sensitive report far outside anyone's watch area still goes on the DPW list, but reaches no resident
    await seedReport('pothole', 'Route 1 shoulder', { ageDays: 5, eastM: 6_000 });
    seedUser('u_jane', { device: true });
    seedUser('u_light', { categories: ['lighting'], device: true });
    seedUser('u_quiet', { device: true, quiet: { start: '22:00', end: '07:00' } });
    seedUser('u_tired', { device: true });
    seedUser('u_far', { eastM: 5_000, device: true });
    seedUser('u_nodevice');
  });

  test('52 mm fires the rain scenario once: run, alert and deliveries written, body naming the places, audience filtered by buffer, category and fatigue', async () => {
    // u_tired already used the week's budget: two distinct non-emergency alerts pushed in the last 7 days
    for (const [i, at] of [NOW - 2 * DAY_MS, NOW - 5 * DAY_MS].entries()) {
      const a = await repos.alerts.createAlert({ scenario_run_id: null, severity: 'advisory', channel_mix: {}, audience_query: {}, hazard_ids: [], forecast_snapshot: null, body: buildAlertBody({ kind: 'wind', severity: 'advisory', forecast: null, validFrom: null, validTo: null, spots: [], hazardCount: 0, now: at }), scheduled_for: null, sent_at: iso(at), created_at: iso(at) });
      await repos.alerts.insertDeliveries([{ alert_id: a.id, user_id: 'u_tired', channel: i === 0 ? 'push' : 'sms', created_at: iso(at) }]);
    }
    // an emergency and an inbox-only delivery never count toward the budget (plan §23.H)
    const emergency = await repos.alerts.createAlert({ scenario_run_id: null, severity: 'emergency', channel_mix: {}, audience_query: {}, hazard_ids: [], forecast_snapshot: null, body: buildAlertBody({ kind: 'wind', severity: 'emergency', forecast: null, validFrom: null, validTo: null, spots: [], hazardCount: 0, now: NOW }), scheduled_for: null, sent_at: iso(NOW - DAY_MS), created_at: iso(NOW - DAY_MS) });
    await repos.alerts.insertDeliveries([{ alert_id: emergency.id, user_id: 'u_jane', channel: 'push', created_at: iso(NOW - DAY_MS) }, { alert_id: emergency.id, user_id: 'u_jane', channel: 'inbox', created_at: iso(NOW - DAY_MS) }]);
    await repos.alerts.saveForecast(forecast());

    const outcome = await evaluateScenarios(ctx(), { repo: repos.alerts });
    expect(outcome.fired).toHaveLength(1);
    const fired = outcome.fired[0];
    expect(fired).toMatchObject({ kind: 'rain', hazards: 4, audience: 3, deliveries: 5 }); // jane, quiet (by day) and nodevice; 3 inbox + 2 push rows
    expect(Object.values(outcome.skipped)).toEqual(['no match', 'no match']); // wind: no gust fact ≥ 60; freeze: temps above freezing
    expect(repos.alerts.scenarios.map((s) => s.kind)).toEqual(['rain', 'wind', 'freeze']); // seeded from the code defaults

    const run = repos.alerts.runs[0];
    expect(run).toMatchObject({ id: fired.runId, status: 'dispatched', audience_count: 3, forecast_id: repos.alerts.forecasts[0].id, triggered_at: iso(NOW) });
    const byScore = [drain, cluster, ponding, repos.reports.rows.find((r) => r.address_text === 'Route 1 shoulder')!].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map((r) => r.id);
    expect(run.worklist).toEqual(byScore);
    expect(run.worklist).not.toContain(limb.id);

    const alert = repos.alerts.alerts.find((a) => a.id === fired.alertId)!;
    expect(alert).toMatchObject({ scenario_run_id: run.id, severity: 'warning', channel_mix: { push: true, inbox: true }, hazard_ids: byScore, sent_at: iso(NOW) });
    expect(alert.forecast_snapshot).toMatchObject({ rainMm6h: 52, popPct: 84 });
    expect(alert.audience_query).toMatchObject({ buffer_m: AUDIENCE_BUFFER_M, fatigue_budget: FATIGUE_BUDGET, fatigued: 1, quiet: 0, candidates: 4 }); // u_light (category) and u_far (distance) never reach the candidate list
    const body = alert.body;
    expect(body.title).toMatch(/^Heavy rain from 8:00 PM — 52 mm · 4 open hazards sensitive to rain$/); // the storm's onset, not the 2:00 PM poll
    for (const place of ['George St & Bayard St', 'Hamilton St, 200–400 block', 'Sandford St & Baldwin St']) expect(body.body).toContain(place);
    expect(body.body).toMatch(/Take the other side of the street/);
    expect(body.why).toMatch(/within 400 m/);
    expect(body.spots.map((s) => s.reportId)).toEqual(byScore);
    expect(body.spots.find((s) => s.reportId === drain.id)).toEqual({ reportId: drain.id, title: 'Blocked tree-pit drain', line: 'George St & Bayard St · 38 days open · Blocked tree-pit drain', distanceM: null });
    expect(body.cityAction).toMatch(/DPW as a pre-storm work list/);
    expect(body.forecast).toEqual({ source: 'NWS gridpoint forecast', issuedAt: forecast().issued_at, rainMm6h: 52, popPct: 84, gustKmh: 40, tempMinC: 11 });
    expect(body.validFrom).toBe(iso(NOW + 6 * HOUR_MS)); // the peak 6 h of RAIN_BY_HOUR
    expect(body.validTo).toBe(iso(NOW + 12 * HOUR_MS));

    const rows = repos.alerts.deliveries.filter((d) => d.alert_id === alert.id);
    const inbox = rows.filter((d) => d.channel === 'inbox').map((d) => d.user_id).sort();
    const push = rows.filter((d) => d.channel === 'push').map((d) => d.user_id).sort();
    expect(inbox).toEqual(['u_jane', 'u_nodevice', 'u_quiet']);
    expect(push).toEqual(['u_jane', 'u_quiet']);
    expect(rows.every((d) => d.status === 'queued' && d.created_at === iso(NOW))).toBe(true);
    // u_light watches lighting only, u_far is 5 km away, u_tired is over budget
    expect(inbox).not.toContain('u_light');
    expect(inbox).not.toContain('u_far');
    expect(inbox).not.toContain('u_tired');

    // the same evening again: the cooldown holds, nothing new is written
    const again = await evaluateScenarios(ctx(NOW + 2 * HOUR_MS), { repo: repos.alerts });
    expect(again.fired).toEqual([]);
    expect(again.skipped[repos.alerts.scenarios[0].id]).toBe('cooldown');
    expect(repos.alerts.alerts).toHaveLength(4);
    expect(repos.alerts.runs).toHaveLength(1);
    // the JobFn wrapper reports the same outcome shape
    expect(await scenarioEval({ ...ctx(NOW + 2 * HOUR_MS + 60_000), store: repos.jobsStore, cursor: null })).toMatchObject({ done: true, processed: 0, note: expect.stringMatching(/nothing fired/) });
  });

  test('10 mm does not fire; a stale or missing forecast does not fire — stale means polled 3 h ago, not issued by NWS 3 h ago', async () => {
    await repos.alerts.saveForecast(forecast({ rain_mm: 10 }));
    const outcome = await evaluateScenarios(ctx(), { repo: repos.alerts });
    expect(outcome.fired).toEqual([]);
    expect(Object.values(outcome.skipped)).toEqual(['no match', 'no match', 'no match']);
    expect(repos.alerts.alerts).toEqual([]);
    expect(repos.alerts.deliveries).toEqual([]);
    await repos.alerts.saveForecast(forecast({ valid_from: iso(NOW - 4 * HOUR_MS) }));
    expect((await evaluateScenarios(ctx(), { repo: repos.alerts })).note).toMatch(/forecast stale \(240 min\)/);
    expect(repos.alerts.alerts).toEqual([]);
    // a WFO grid published hours before a fresh poll is still evaluated (the issue time is the briefing's "issued" line)
    await repos.alerts.saveForecast(forecast({ rain_mm: 10, issued_at: iso(NOW - 8 * HOUR_MS) }));
    expect((await evaluateScenarios(ctx(), { repo: repos.alerts })).forecastId).toBe(repos.alerts.forecasts[2].id);
    const fresh = createMemoryRepos();
    expect((await evaluateScenarios(ctx(), { repo: fresh.alerts })).note).toMatch(/no forecast stored yet/);
  });

  test('no hourly series in the row: the rain scenario still fires, with no onset in the headline and no window on the briefing', async () => {
    await repos.alerts.saveForecast(forecast({ payload: {} }));
    const outcome = await evaluateScenarios(ctx(), { repo: repos.alerts });
    expect(outcome.fired.map((f) => f.kind)).toEqual(['rain']);
    const body = repos.alerts.alerts[0].body;
    expect(body.title).toBe('Heavy rain — 52 mm · 4 open hazards sensitive to rain');
    expect(body.validFrom).toBeNull();
    expect(body.validTo).toBeNull();
  });

  test('a polled fixture: the briefing window is the peak 6 h of the stored series (8 PM, not the 2 PM poll), and an NWS product issued 8 h before the poll is evaluated', async () => {
    const stale = hourlyFixture as unknown as { properties: Record<string, unknown> };
    const hourly = { ...stale, properties: { ...stale.properties, updateTime: iso(NOW - 8 * HOUR_MS) } };
    const { row } = await pollWeather(ctx(), { fetchFn: nwsFetch({}, hourly).fn });
    expect(row!.issued_at).toBe(iso(NOW - 8 * HOUR_MS));
    const outcome = await evaluateScenarios(ctx(), { repo: repos.alerts });
    expect(outcome.forecastId).toBe(row!.id);
    expect(outcome.fired.map((f) => f.kind)).toEqual(['rain']);
    const body = repos.alerts.alerts[0].body;
    expect(body.title).toMatch(/^Heavy rain from 8:00 PM — 48 mm · 4 open hazards sensitive to rain$/);
    expect(body.validFrom).toBe(iso(NOW + 6 * HOUR_MS));
    expect(body.validTo).toBe(iso(NOW + 12 * HOUR_MS));
    expect(body.forecast).toMatchObject({ issuedAt: iso(NOW - 8 * HOUR_MS) });
  });

  test('quiet hours keep a resident out at night and let them in by day; the storm multiplier reads from the active run', async () => {
    await repos.alerts.saveForecast(forecast({ issued_at: iso(edt(23) - 20 * 60_000), valid_from: iso(edt(23)), valid_to: iso(edt(23) + 24 * HOUR_MS) }));
    const night = await evaluateScenarios(ctx(edt(23)), { repo: repos.alerts });
    expect(night.fired[0]).toMatchObject({ kind: 'rain', audience: 3 });
    const users = repos.alerts.deliveries.filter((d) => d.channel === 'inbox').map((d) => d.user_id).sort();
    expect(users).toEqual(['u_jane', 'u_nodevice', 'u_tired']);
    expect(repos.alerts.alerts[0].audience_query).toMatchObject({ quiet: 1, fatigued: 0 });
    expect(await activeStormMultiplier(['rain'], { repo: repos.alerts, now: edt(23) })).toBe(1.4);
    expect(await activeStormMultiplier(['rain', 'freeze'], { repo: repos.alerts, now: edt(23) })).toBe(1.4);
    expect(await activeStormMultiplier(['wind'], { repo: repos.alerts, now: edt(23) })).toBe(1);
    expect(await activeStormMultiplier([], { repo: repos.alerts, now: edt(23) })).toBe(1);
    expect(await activeStormMultiplier(['rain'], { repo: repos.alerts, now: edt(23) + 25 * HOUR_MS })).toBe(1); // the window is over
  });

  test('wind and freeze scenarios fire on their own facts with their own reports and multipliers', async () => {
    await repos.alerts.saveForecast(forecast({ rain_mm: 2, pop_pct: 20, gust_kmh: 70, temp_min: -4, temp_max: 3 }));
    const outcome = await evaluateScenarios(ctx(), { repo: repos.alerts });
    expect(outcome.fired.map((f) => f.kind)).toEqual(['wind', 'freeze']);
    const wind = repos.alerts.alerts.find((a) => a.body.trigger === 'wind')!;
    expect(wind.severity).toBe('advisory'); // ×1.3 and no rain confidence
    expect(wind.hazard_ids).toEqual([limb.id]);
    // wind and freeze have no onset logic yet: no window, and the headline names no time rather than the poll time
    expect(wind.body.title).toBe('High wind — gusts to 70 km/h · 1 open hazard sensitive to wind');
    expect(wind.body.validFrom).toBeNull();
    expect(wind.body.body).toContain('52 Easton Ave');
    const freeze = repos.alerts.alerts.find((a) => a.body.trigger === 'freeze')!;
    expect(freeze.hazard_ids.sort()).toEqual([cluster.id, ponding.id, repos.reports.rows.find((r) => r.address_text === 'Route 1 shoulder')!.id].sort());
    expect(freeze.body.title).toMatch(/^Freeze–thaw — low -4 °C · 3 open hazards sensitive to freeze–thaw$/);
    expect(await activeStormMultiplier(['freeze'], { repo: repos.alerts, now: NOW })).toBe(1.2);
    expect(await activeStormMultiplier(['wind', 'freeze'], { repo: repos.alerts, now: NOW })).toBe(1.3);
  });
});

describe('alertDispatch', () => {
  async function queueFor(users: string[], opts: { severity?: 'advisory' | 'warning' | 'emergency' } = {}) {
    const alert = await repos.alerts.createAlert({ scenario_run_id: null, severity: opts.severity ?? 'warning', channel_mix: { push: true, inbox: true }, audience_query: {}, hazard_ids: [], forecast_snapshot: null, body: buildAlertBody({ kind: 'rain', severity: opts.severity ?? 'warning', forecast: null, validFrom: null, validTo: null, spots: [{ reportId: 'rc_1', title: 'Ponding', address: 'Sandford St & Baldwin St', subtype: 'ponding', createdAt: iso(NOW - DAY_MS) }], hazardCount: 1, now: NOW }), scheduled_for: iso(NOW), sent_at: iso(NOW), created_at: iso(NOW) });
    await repos.alerts.insertDeliveries(users.flatMap((user_id, i) => [{ alert_id: alert.id, user_id, channel: 'inbox' as const, created_at: iso(NOW + i) }, { alert_id: alert.id, user_id, channel: 'push' as const, created_at: iso(NOW + i) }]));
    return alert;
  }

  test('sends at most DISPATCH_PER_TICK queued pushes per call, oldest first, one message per device, and records the ticket ids', async () => {
    const users = Array.from({ length: 25 }, (_, i) => `u_${String(i).padStart(2, '0')}`);
    for (const u of users) {
      repos.users.seed({ id: u, display_name: u });
      repos.alerts.seedDevice({ user_id: u, expo_push_token: token(u), platform: i(u) });
    }
    repos.alerts.seedDevice({ user_id: 'u_00', expo_push_token: token('u_00-tablet'), platform: 'android' });
    const alert = await queueFor(users);
    expect(DISPATCH_PER_TICK).toBe(20);

    const first = await dispatchQueuedPushes(ctx(), { repo: repos.alerts });
    expect(first).toEqual({ sent: 20, failed: 0, noDevice: 0 });
    const messages = sent.flat();
    expect(messages).toHaveLength(21); // u_00 has two devices
    expect(messages[0]).toMatchObject({ to: token('u_00'), title: alert.body.title, body: alert.body.body, data: { kind: 'warning', alertId: alert.id }, channelId: ALERTS_CHANNEL, priority: 'default' });
    const pushRows = repos.alerts.deliveries.filter((d) => d.channel === 'push');
    const sentRows = pushRows.filter((d) => d.status === 'sent');
    expect(sentRows).toHaveLength(20);
    expect(sentRows.map((d) => d.user_id)).toEqual(users.slice(0, 20));
    expect(sentRows.every((d) => d.provider_id === `t_${token(d.user_id)}` && d.sent_at === iso(NOW) && d.error === null)).toBe(true);
    expect(pushRows.filter((d) => d.status === 'queued').map((d) => d.user_id)).toEqual(users.slice(20));
    expect(repos.alerts.deliveries.filter((d) => d.channel === 'inbox').every((d) => d.status === 'queued')).toBe(true);

    const second = await alertDispatch({ ...ctx(), store: repos.jobsStore, cursor: null });
    expect(second).toMatchObject({ done: true, processed: 5, note: 'sent 5, failed 0, no device 0' });
    expect(repos.alerts.deliveries.filter((d) => d.channel === 'push' && d.status === 'queued')).toEqual([]);
    expect(await alertDispatch({ ...ctx(), store: repos.jobsStore, cursor: null })).toMatchObject({ done: true, processed: 0, note: 'nothing queued' });
  });

  test('a rejected ticket marks the row failed with the reason; an account without a device is failed as such; an emergency goes out high priority', async () => {
    for (const u of ['u_gone', 'u_fine']) {
      repos.users.seed({ id: u, display_name: u });
      repos.alerts.seedDevice({ user_id: u, expo_push_token: token(u), platform: 'ios' });
    }
    repos.users.seed({ id: 'u_bare', display_name: 'u_bare' });
    fakeSender((m) => (String(m.to) === token('u_gone') ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered', expoPushToken: String(m.to) } } : { status: 'ok', id: 'ok_1' }));
    await queueFor(['u_gone', 'u_fine', 'u_bare'], { severity: 'emergency' });
    const outcome = await dispatchQueuedPushes(ctx(), { repo: repos.alerts });
    expect(outcome).toEqual({ sent: 1, failed: 1, noDevice: 1 });
    const row = (u: string) => repos.alerts.deliveries.find((d) => d.channel === 'push' && d.user_id === u)!;
    expect(row('u_gone')).toMatchObject({ status: 'failed', provider_id: null, error: 'DeviceNotRegistered: not registered' });
    expect(row('u_fine')).toMatchObject({ status: 'sent', provider_id: 'ok_1', sent_at: iso(NOW) });
    expect(row('u_bare')).toMatchObject({ status: 'failed', error: 'no device' });
    expect(sent.flat().every((m) => m.priority === 'high')).toBe(true);
  });

  function i(u: string): 'ios' | 'android' {
    return u.endsWith('1') ? 'android' : 'ios';
  }
});
