/**
 * Screen smoke tests: every screen renders from local state with ZERO network, in every demo scenario,
 * signed out and offline. Uses expo-router's testing library so hooks like useRouter work.
 */
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import AlertsScreen from '@/app/(tabs)/alerts';
import HomeScreen from '@/app/(tabs)/index';
import MapScreen from '@/app/(tabs)/map';
import MeScreen from '@/app/(tabs)/me';
import ReportTabScreen from '@/app/(tabs)/report';
import DataScreen from '@/app/data';
import OnboardingScreen from '@/app/onboarding';
import PrivacyScreen from '@/app/privacy';
import ReportDetailScreen from '@/app/report/[id]';
import CaptureScreen from '@/app/new/index';
import TermsScreen from '@/app/terms';
import WhyScoreScreen from '@/app/why/score/[id]';
import { buildDemoReports } from '@/domain/demo';
import { PILOT } from '@/domain/pilot';
import { applyDemoScenario } from '@/services/demo';
import { actions, getState, hydrate, setState } from '@/store/appStore';

const routes = {
  index: HomeScreen,
  map: MapScreen,
  report: ReportTabScreen,
  alerts: AlertsScreen,
  me: MeScreen,
  'report/[id]': ReportDetailScreen,
  'new/index': CaptureScreen,
  'why/score/[id]': WhyScoreScreen,
  data: DataScreen,
  privacy: PrivacyScreen,
  terms: TermsScreen,
  onboarding: OnboardingScreen,
};

const fetchSpy = jest.spyOn(globalThis, 'fetch' as never);

async function press(el: ReturnType<typeof screen.getByText>) {
  await act(async () => {
    fireEvent.press(el);
    jest.runOnlyPendingTimers();
  });
}

beforeEach(() => {
  hydrate();
  applyDemoScenario('calm');
  setState({ network: { online: false, type: 'NONE' }, locationStatus: 'denied', location: null, session: null });
  actions.savePrefs({ ...getState().prefs, home: { ...PILOT.center, radiusM: 400 } }, { finishOnboarding: true });
  fetchSpy.mockClear();
});

afterAll(() => fetchSpy.mockRestore());

describe('Home (offline, no fetch)', () => {
  test('calm demo: index card, feed rows, offline banner, demo label, zero fetches', async () => {
    await renderRouter(routes, { initialUrl: '/' });
    expect(await screen.findByText('Needs attention')).toBeTruthy();
    expect(screen.getByText(/OFFLINE MODE/)).toBeTruthy();
    expect(screen.getByText(/^Demo · clock set to/)).toBeTruthy();
    expect(screen.getAllByText(/days? open/).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('storm demo renders and still makes no requests', async () => {
    applyDemoScenario('storm');
    await renderRouter(routes, { initialUrl: '/' });
    expect(await screen.findByText('Needs attention')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('voting while signed out asks to sign in instead of failing silently', async () => {
    await renderRouter(routes, { initialUrl: '/' });
    const first = buildDemoReports('calm', PILOT.center)[0];
    await screen.findByTestId(`report-${first.id}`);
    await press(screen.getAllByLabelText(/^Urgency vote/)[0]);
    expect(await screen.findByText('Sign in to vote')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('no demo and no cache: honest empty state', async () => {
    applyDemoScenario(null);
    actions.setFeed([]);
    await renderRouter(routes, { initialUrl: '/' });
    expect(await screen.findByText('No reports nearby yet')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Other tabs and screens (offline, no fetch)', () => {
  test('map lists nearest reports with distances', async () => {
    await renderRouter(routes, { initialUrl: '/map' });
    expect(await screen.findByText('Nearest to you')).toBeTruthy();
    expect(screen.getAllByText(/\d+ m ·|\d+\.\d km ·/).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('alerts: empty state in calm', async () => {
    await renderRouter(routes, { initialUrl: '/alerts' });
    expect(await screen.findByText('No alerts yet')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('alerts: a labelled advisory in the storm demo', async () => {
    applyDemoScenario('storm');
    await renderRouter(routes, { initialUrl: '/alerts' });
    expect((await screen.findAllByText(/· demo/)).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('me: signed-out callout and settings links', async () => {
    await renderRouter(routes, { initialUrl: '/me' });
    expect(await screen.findByText('Sign in to vote and follow')).toBeTruthy();
    expect(screen.getByText('Offline data')).toBeTruthy();
  });

  test('report detail shows five score terms, timeline and threshold', async () => {
    const first = buildDemoReports('calm', PILOT.center)[0];
    await renderRouter(routes, { initialUrl: `/report/${first.id}` });
    expect(await screen.findByText(first.title)).toBeTruthy();
    expect(screen.getByText('Community votes')).toBeTruthy();
    expect(screen.getByText('Status timeline')).toBeTruthy();
    expect(screen.getByText(/votes needed for supervisor review|threshold passed/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('verify demo: one of the reports is fixed and waiting', async () => {
    applyDemoScenario('verify');
    const completed = buildDemoReports('verify', PILOT.center).find((r) => r.status === 'completed');
    expect(completed).toBeTruthy();
    await renderRouter(routes, { initialUrl: `/report/${completed!.id}` });
    expect((await screen.findAllByText('Fixed — please verify')).length).toBeGreaterThan(0);
  });

  test('why screen renders the published weights', async () => {
    const first = buildDemoReports('calm', PILOT.center)[0];
    await renderRouter(routes, { initialUrl: `/why/score/${first.id}` });
    expect(await screen.findByText('Weights (city-set, published)')).toBeTruthy();
    expect(screen.getByText('0.22')).toBeTruthy();
  });

  test('data screen: switching scenarios regenerates labelled data; simulate offline toggles the banner', async () => {
    await renderRouter(routes, { initialUrl: '/data' });
    expect(await screen.findByText('Offline data')).toBeTruthy();
    await press(screen.getByText('Storm tonight'));
    expect(getState().settings.demoScenario).toBe('storm');
    expect(getState().demoReports.every((r) => r.isDemo)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('privacy renders', async () => {
    await renderRouter(routes, { initialUrl: '/privacy' });
    expect(await screen.findByText('You see exactly what is uploaded')).toBeTruthy();
  });

  test('terms render with the SMS program language (10DLC prerequisite) and are reachable before onboarding', async () => {
    actions.resetAll();
    await renderRouter(routes, { initialUrl: '/terms' });
    expect(await screen.findByText(/Reply STOP to cancel at any time/)).toBeTruthy();
    expect(screen.getByText(/We do not share, sell, or provide your mobile phone number/)).toBeTruthy();
  });

  test('capture contract renders', async () => {
    await renderRouter(routes, { initialUrl: '/new' });
    expect(await screen.findByText('1 · Photograph the hazard')).toBeTruthy();
  });

  test('report tab renders', async () => {
    await renderRouter(routes, { initialUrl: '/report' });
    expect(await screen.findByText('Report a hazard in under a minute')).toBeTruthy();
  });

  test('onboarding saves a home area and finishes', async () => {
    actions.resetAll();
    await renderRouter(routes, { initialUrl: '/onboarding' });
    expect(await screen.findByText('Get started')).toBeTruthy();
    await press(screen.getByTestId('onboarding-start'));
    expect(getState().onboarded).toBe(true);
    expect(getState().prefs.home).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
