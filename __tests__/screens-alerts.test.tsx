/**
 * S-03 inbox, S-09 briefing, the S-01 hero and /why (spec R8, R9, R1) render from local state with ZERO network
 * (plan §14 screens tests): the chips filter weather from status, the labelled storm advisory opens its briefing with
 * why / forecast / spots / city action, a spot opens its work order, a server alert kept in the inbox renders its
 * briefing offline and is marked read on the phone without a request, a tapped push's mirror (no briefing) shows the
 * not-found cell until the server copy is merged in, an unknown id is an honest not-found cell, the home hero shows
 * in the storm demo and for an unread live weather alert (never in calm), and "How is this scored?" explains the
 * index with the figures the card shows.
 */
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import AlertsScreen from '@/app/(tabs)/alerts';
import HomeScreen from '@/app/(tabs)/index';
import AlertBriefingScreen from '@/app/alert/[id]';
import ReportDetailScreen from '@/app/report/[id]';
import WhyIndexScreen from '@/app/why/index';
import WhyScoreScreen from '@/app/why/score/[id]';
import { DEMO_STORM_FORECAST, demoStormSpots } from '@/domain/alerts';
import { DEMO_SCENARIOS, buildDemoReports } from '@/domain/demo';
import { PILOT } from '@/domain/pilot';
import type { AlertItem } from '@/domain/types';
import { mergeAlerts, serverAlertItemId, toAlertItem } from '@/services/alerts';
import { applyDemoScenario } from '@/services/demo';
import { actions, getState, hydrate, setState } from '@/store/appStore';

jest.mock('expo-notifications', () => ({ getPermissionsAsync: jest.fn(async () => ({ granted: false })), requestPermissionsAsync: jest.fn(async () => ({ granted: false })) }));

const routes = {
  index: HomeScreen,
  alerts: AlertsScreen,
  'alert/[id]': AlertBriefingScreen,
  'report/[id]': ReportDetailScreen,
  'why/index': WhyIndexScreen,
  'why/score/[id]': WhyScoreScreen,
};

const fetchSpy = jest.spyOn(globalThis, 'fetch' as never);

/** A server alert as GET /api/v1/me/alerts hands it over, already in the inbox. */
const LIVE: AlertItem = toAlertItem({
  id: 'al_000007',
  at: '2026-10-10T20:00:00.000Z',
  read: false,
  body: {
    kind: 'advisory',
    trigger: 'wind',
    title: 'High wind from 6:00 PM — gusts to 65 km/h · 1 open hazard sensitive to wind',
    body: 'Limbs over the walkway at 52 Easton Ave can come down in these gusts. Keep clear of those trees until a crew has checked them.',
    why: 'Your watch area is within 400 m of one or more of the 1 open hazard sensitive to wind.',
    spots: [{ reportId: 'rc_000042', title: 'Hanging or cracked limb over walkway', line: '52 Easton Ave · 61 days open · Hanging or cracked limb over walkway', distanceM: 180 }],
    cityAction: 'The same list went to DPW as a pre-storm work list.',
    validFrom: '2026-10-10T22:00:00.000Z',
    validTo: '2026-10-11T04:00:00.000Z',
    forecast: { source: 'NWS gridpoint forecast', issuedAt: '2026-10-10T19:30:00.000Z', rainMm6h: null, popPct: null, gustKmh: 65, tempMinC: null },
  },
});
const STATUS: AlertItem = { id: 'n_1', kind: 'status', title: '12 Somerset St: Confirmed by inspector', body: 'Open the report to see the timeline.', reportId: 'rc_000001', alertId: null, at: '2026-10-10T18:00:00.000Z', read: true };

async function press(el: ReturnType<typeof screen.getByText>) {
  await act(async () => {
    await fireEvent.press(el);
  });
}

beforeEach(() => {
  actions.resetAll();
  hydrate();
  applyDemoScenario('storm');
  setState({ network: { online: false, type: 'NONE' }, locationStatus: 'denied', location: null, session: null });
  actions.savePrefs({ ...getState().prefs, home: { ...PILOT.center, radiusM: 400 } }, { finishOnboarding: true });
  fetchSpy.mockClear();
});

afterAll(() => fetchSpy.mockRestore());

describe('S-03 inbox (offline, no fetch)', () => {
  test('chips filter weather from status; the storm advisory is labelled demo; the rules cell is there', async () => {
    actions.setAlerts([STATUS]);
    await renderRouter(routes, { initialUrl: '/alerts' });
    expect(await screen.findByText(`${DEMO_SCENARIOS.storm.alertTitle} · demo`)).toBeTruthy();
    expect(screen.getByText(STATUS.title)).toBeTruthy();
    expect(screen.getByText('Edit alert rules')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Weather' })).toBeTruthy();
    await press(screen.getByText('Status'));
    expect(screen.queryByText(/· demo$/)).toBeNull();
    expect(screen.getByText(STATUS.title)).toBeTruthy();
    await press(screen.getByText('Weather'));
    expect(screen.getByText(`${DEMO_SCENARIOS.storm.alertTitle} · demo`)).toBeTruthy();
    expect(screen.queryByText(STATUS.title)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('empty states per chip in calm', async () => {
    applyDemoScenario('calm');
    await renderRouter(routes, { initialUrl: '/alerts' });
    expect(await screen.findByText('No alerts yet')).toBeTruthy();
    await press(screen.getByText('Weather'));
    expect(screen.getByText('No weather alerts yet')).toBeTruthy();
    await press(screen.getByText('Status'));
    expect(screen.getByText('No status updates yet')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('tapping the storm advisory opens the briefing: why, forecast, spots, city action, back', async () => {
    await renderRouter(routes, { initialUrl: '/alerts' });
    await press(await screen.findByText(`${DEMO_SCENARIOS.storm.alertTitle} · demo`));
    expect(await screen.findByTestId('alert-briefing')).toBeTruthy();
    expect(screen.getByText('Why you got this')).toBeTruthy();
    expect(screen.getByText('The spots')).toBeTruthy();
    expect(screen.getByText('What the city is doing')).toBeTruthy();
    expect(screen.getByText('Sent to the city too')).toBeTruthy();
    expect(screen.getByText(`${DEMO_STORM_FORECAST.rainMm6h} mm`)).toBeTruthy();
    expect(screen.getByText(`${DEMO_STORM_FORECAST.popPct}%`)).toBeTruthy();
    expect(screen.getByText(`${DEMO_STORM_FORECAST.gustKmh} km/h`)).toBeTruthy();
    expect(screen.getByText(/within 400 m/)).toBeTruthy();
    expect(screen.getByText('The same list went to DPW as a pre-storm work list.')).toBeTruthy();
    const spots = demoStormSpots(buildDemoReports('storm', PILOT.center));
    expect(spots.length).toBeGreaterThan(0);
    for (const s of spots) expect(screen.getByTestId(`alert-spot-${s.id}`)).toBeTruthy();
    expect(screen.getAllByText(/\d+ m · |\d+\.\d km · /).length).toBe(spots.length);
    expect(screen.getByText('Back to alerts')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a spot opens its work order', async () => {
    const spot = demoStormSpots(buildDemoReports('storm', PILOT.center))[0];
    await renderRouter(routes, { initialUrl: '/alert/demo-storm' });
    await press(await screen.findByTestId(`alert-spot-${spot.id}`));
    expect(await screen.findByTestId('report-detail')).toBeTruthy();
    expect(screen.getAllByText(spot.title).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('S-09 briefing for live alerts (offline, no fetch)', () => {
  test('renders the stored briefing and marks the alert read on the phone without a request', async () => {
    applyDemoScenario(null);
    actions.setFeed([]);
    actions.setAlerts([LIVE, STATUS]);
    await renderRouter(routes, { initialUrl: `/alert/${LIVE.id}` });
    expect(await screen.findByText(LIVE.title)).toBeTruthy();
    expect(screen.getByText('Wind briefing')).toBeTruthy();
    expect(screen.getByText('65 km/h')).toBeTruthy();
    expect(screen.getByText(/180 m · 52 Easton Ave · 61 days open/)).toBeTruthy();
    expect(screen.queryByText('Rain, worst 6 hours')).toBeNull();
    expect(getState().alerts.find((a) => a.id === LIVE.id)?.read).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a push deep link by the server alert id resolves the same item', async () => {
    applyDemoScenario(null);
    actions.setFeed([]);
    actions.setAlerts([LIVE]);
    await renderRouter(routes, { initialUrl: `/alert/${LIVE.alertId}` });
    expect(await screen.findByText(LIVE.title)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a tapped predictive push: its mirror carries no briefing, so the screen is the not-found cell until the server copy is merged in, then the briefing', async () => {
    applyDemoScenario(null);
    actions.setFeed([]);
    const mirror: AlertItem = { id: 'n_push', kind: 'advisory', title: LIVE.title, body: LIVE.body, reportId: null, alertId: LIVE.alertId, at: LIVE.at, read: true };
    actions.setAlerts([mirror]);
    await renderRouter(routes, { initialUrl: `/alert/${LIVE.alertId}` });
    expect(await screen.findByText('Alert not found')).toBeTruthy();
    // what refreshAlerts() does once GET /api/v1/me/alerts answers (services/notifications.ts asks for it on the tap)
    await act(async () => {
      actions.setAlerts(mergeAlerts(getState().alerts, [LIVE]));
    });
    expect(await screen.findByText('Wind briefing')).toBeTruthy();
    expect(screen.queryByText('Alert not found')).toBeNull();
    expect(getState().alerts.map((a) => a.id)).toEqual([LIVE.id]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('an unknown id is an honest not-found cell with a way back', async () => {
    applyDemoScenario(null);
    actions.setFeed([]);
    actions.setAlerts([LIVE]);
    await renderRouter(routes, { initialUrl: '/alert/al_nope' });
    expect(await screen.findByText('Alert not found')).toBeTruthy();
    expect(screen.getByText('Back to alerts')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('the demo advisory exists only while the storm scenario runs', async () => {
    applyDemoScenario('calm');
    await renderRouter(routes, { initialUrl: '/alert/demo-storm' });
    expect(await screen.findByText('Alert not found')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('mergeAlerts: the server list replaces push mirrors of the same alert, keeps local status alerts and a local read mark', () => {
    const mirror: AlertItem = { id: 'n_push', kind: 'advisory', title: 'x', body: 'y', reportId: null, alertId: LIVE.alertId, at: LIVE.at, read: true };
    const stale: AlertItem = { ...LIVE, id: serverAlertItemId('al_old'), alertId: 'al_old', at: '2026-09-01T00:00:00.000Z' };
    const merged = mergeAlerts([STATUS, mirror, stale], [LIVE]);
    expect(merged.map((a) => a.id)).toEqual([LIVE.id, STATUS.id]);
    expect(merged[0].read).toBe(true);
    expect(merged[0].briefing).toEqual(LIVE.briefing);
  });
});

describe('S-01 hero and /why (offline, no fetch)', () => {
  test('storm demo: the hero names the alert and "See the spots" opens the briefing; Map view and How is this scored? sit under the index', async () => {
    await renderRouter(routes, { initialUrl: '/' });
    expect(await screen.findByText('⚠ Predictive alert · active')).toBeTruthy();
    expect(screen.getByText(`${DEMO_SCENARIOS.storm.alertTitle} · demo`)).toBeTruthy();
    expect(screen.getByText('Open alerts')).toBeTruthy();
    expect(screen.getByTestId('home-map-link')).toBeTruthy();
    expect(screen.getByTestId('home-why-link')).toBeTruthy();
    await press(screen.getByTestId('home-hero-spots'));
    expect(await screen.findByTestId('alert-briefing')).toBeTruthy();
    expect(screen.getByText('Why you got this')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('calm demo: no hero', async () => {
    applyDemoScenario('calm');
    await renderRouter(routes, { initialUrl: '/' });
    expect(await screen.findByText('Needs attention')).toBeTruthy();
    expect(screen.queryByText('⚠ Predictive alert · active')).toBeNull();
    expect(screen.getByTestId('home-map-link')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('no demo: an unread live weather alert is the hero', async () => {
    applyDemoScenario(null);
    actions.setFeed([]);
    actions.setAlerts([LIVE, STATUS]);
    await renderRouter(routes, { initialUrl: '/' });
    expect(await screen.findByText('⚠ Predictive alert · active')).toBeTruthy();
    expect(screen.getByText(LIVE.title)).toBeTruthy();
    expect(screen.getByText('See the spots')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('no demo: a read weather alert and a status alert show no hero', async () => {
    applyDemoScenario(null);
    actions.setFeed([]);
    actions.setAlerts([{ ...LIVE, read: true }, STATUS]);
    await renderRouter(routes, { initialUrl: '/' });
    expect(await screen.findByText('No reports nearby yet')).toBeTruthy();
    expect(screen.queryByText('⚠ Predictive alert · active')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('"How is this scored?" explains the index with the figures the card shows and links each driver to its score', async () => {
    await renderRouter(routes, { initialUrl: '/' });
    await press(await screen.findByTestId('home-why-link'));
    expect(await screen.findByTestId('why-index')).toBeTruthy();
    expect(screen.getByText('How the index is scored')).toBeTruthy();
    expect(screen.getByText('800 m')).toBeTruthy();
    expect(screen.getByText('your home area')).toBeTruthy();
    expect(screen.getByText(/not a prediction/)).toBeTruthy();
    expect(screen.getByText('0.22')).toBeTruthy();
    const drivers = screen.getAllByTestId(/^why-driver-/);
    expect(drivers.length).toBeGreaterThan(0);
    expect(drivers.length).toBeLessThanOrEqual(3);
    await press(drivers[0]);
    expect(await screen.findByText('Weights (city-set, published)')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
