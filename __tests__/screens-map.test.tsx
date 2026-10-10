/**
 * S-02 Map tab offline (plan §14 "HazardMap mocked renders pins from cached GeoJSON", §23.F test wording): the pins
 * mirror the list one for one, the category filter narrows both, the peek card opens from a pin and leads to the
 * detail, "Report what I see here" opens /new, the tiles-unavailable line and the attribution show, and nothing is
 * fetched. Same fixtures and offline state as __tests__/screens.test.tsx.
 */
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import MapScreen from '@/app/(tabs)/map';
import CaptureScreen from '@/app/new/index';
import ReportDetailScreen from '@/app/report/[id]';
import { buildDemoReports } from '@/domain/demo';
import { PILOT } from '@/domain/pilot';
import { applyDemoScenario } from '@/services/demo';
import { actions, getState, hydrate, setState } from '@/store/appStore';

const routes = { map: MapScreen, 'report/[id]': ReportDetailScreen, 'new/index': CaptureScreen };

const fetchSpy = jest.spyOn(globalThis, 'fetch' as never);

/** The map canvas is hidden from assistive tech by design (the list is the mirror), so RNTL must be told to look inside it for pins. */
const hidden = { includeHiddenElements: true } as const;

async function press(el: ReturnType<typeof screen.getByText>) {
  await act(async () => {
    await fireEvent.press(el);
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

describe('Map tab (offline, no fetch)', () => {
  test('pins mirror the list one for one, the offline line and the attribution show, zero fetches', async () => {
    const demo = buildDemoReports('calm', PILOT.center);
    await renderRouter(routes, { initialUrl: '/map' });
    expect(await screen.findByText('Nearest to you')).toBeTruthy();
    const pins = screen.getAllByTestId(/^mlrn-feature-/, hidden);
    const rows = screen.getAllByTestId(/^map-row-/);
    expect(pins).toHaveLength(demo.length);
    expect(rows).toHaveLength(demo.length);
    expect(screen.getByText('Map tiles unavailable offline · showing saved reports')).toBeTruthy();
    expect(screen.getAllByText(/© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors/).length).toBeGreaterThan(0);
    expect(screen.getByText(/OFFLINE MODE/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('the category filter narrows the pins and the list together', async () => {
    const drainage = buildDemoReports('calm', PILOT.center).filter((r) => r.category === 'drainage');
    expect(drainage.length).toBeGreaterThan(0);
    await renderRouter(routes, { initialUrl: '/map' });
    await screen.findByText('Nearest to you');
    await press(screen.getByText('Drains'));
    expect(screen.getAllByTestId(/^mlrn-feature-/, hidden)).toHaveLength(drainage.length);
    expect(screen.getAllByTestId(/^map-row-/)).toHaveLength(drainage.length);
    for (const r of drainage) expect(screen.getByTestId(`mlrn-feature-${r.id}`, hidden)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('pressing a pin opens the peek card with the words for the colour; Open goes to the report; Close dismisses', async () => {
    const target = buildDemoReports('calm', PILOT.center)[3]!;
    await renderRouter(routes, { initialUrl: '/map' });
    await screen.findByText('Nearest to you');
    expect(screen.queryByTestId('map-peek')).toBeNull();
    await press(screen.getByTestId(`mlrn-feature-${target.id}`, hidden));
    const peek = await screen.findByTestId('map-peek');
    expect(peek).toBeTruthy();
    // Demo titles carry a nested " · demo" span, so match the title as a prefix: once in the peek, once in the list row.
    expect(screen.getAllByText(new RegExp(`^${target.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)).length).toBe(2);
    expect(screen.getByText(new RegExp(`${target.voteCount} votes`))).toBeTruthy();
    await press(screen.getByTestId('map-peek-close'));
    expect(screen.queryByTestId('map-peek')).toBeNull();
    await press(screen.getByTestId(`mlrn-feature-${target.id}`, hidden));
    await press(await screen.findByTestId('map-peek-open'));
    expect(await screen.findByText('Status timeline')).toBeTruthy(); // S-08 for that report
    expect(screen.getByText(new RegExp(`^${target.id}`))).toBeTruthy(); // the id line also carries " · demo"
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('"Report what I see here" opens the capture flow', async () => {
    await renderRouter(routes, { initialUrl: '/map' });
    await screen.findByText('Nearest to you');
    await press(screen.getByTestId('map-report-here'));
    expect(await screen.findByText('1 · Photograph the hazard')).toBeTruthy(); // S-04 at /new
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('no demo and no cache: the honest empty state, no pins, attribution still visible', async () => {
    applyDemoScenario(null);
    actions.setFeed([]);
    await renderRouter(routes, { initialUrl: '/map' });
    expect(await screen.findByText('No reports nearby yet')).toBeTruthy();
    expect(screen.queryAllByTestId(/^mlrn-feature-/, hidden)).toHaveLength(0);
    expect(screen.getAllByText(/© OpenFreeMap/).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
