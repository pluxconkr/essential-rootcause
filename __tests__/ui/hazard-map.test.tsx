/**
 * HazardMap (native) through the maplibre-react-native mock: one pin feature per report, clustered source, the
 * three layers, pin press → onSelect(id), background press → onSelect(null), attribution and the offline line.
 * Plus the pure helpers the native and web maps share (plan §3.3, §13, §23.F).
 */
import { fireEvent, render, screen } from '@testing-library/react-native';

import { buildDemoReports } from '@/domain/demo';
import { PILOT } from '@/domain/pilot';
import { VOTE_THRESHOLDS } from '@/domain/votes';
import { HazardMap } from '@/ui/HazardMap';
import { CLUSTER, LAYER_ID, MAP_VIEW, PIN_RADIUS, SOURCE_ID, pinPaint, pinsToGeoJSON, toPins } from '@/ui/HazardMap.shared';
import { colors, severityTone, toneColor } from '@/ui/theme';

const reports = buildDemoReports('calm', PILOT.center);
const pins = toPins(reports);

/** The map canvas is hidden from assistive tech by design (the list below the map is the mirror), so RNTL must be told to look inside it. */
const hidden = { includeHiddenElements: true } as const;

describe('HazardMap (native, mocked MapLibre)', () => {
  test('renders one pin feature per report in a clustered source with the cluster, count and pin layers', async () => {
    await render(<HazardMap pins={pins} center={PILOT.center} selectedId={null} onSelect={() => {}} offline={false} height={300} />);
    expect(screen.getAllByTestId(/^mlrn-feature-/, hidden)).toHaveLength(reports.length);
    expect(screen.getByTestId(`mlrn-source-${SOURCE_ID}`, hidden).props.accessibilityLabel).toBe('clustered');
    expect(screen.getAllByTestId('mlrn-circle-layer', hidden)).toHaveLength(2);
    expect(screen.getByTestId('mlrn-symbol-layer', hidden).props.accessibilityLabel).toBe(LAYER_ID.clusterCount);
    expect(screen.getByTestId('mlrn-camera', hidden).props.accessibilityLabel).toBe(JSON.stringify({ center: [PILOT.center.lng, PILOT.center.lat], zoom: MAP_VIEW.zoom }));
  });

  test('pressing a pin selects its report; pressing the background clears the selection', async () => {
    const onSelect = jest.fn();
    await render(<HazardMap pins={pins} center={PILOT.center} selectedId={null} onSelect={onSelect} offline={false} height={300} />);
    await fireEvent.press(screen.getByTestId(`mlrn-feature-${reports[2]!.id}`, hidden));
    expect(onSelect).toHaveBeenLastCalledWith(reports[2]!.id);
    await fireEvent.press(screen.getByTestId('hazard-map-map-background', hidden));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  test('the attribution is visible in every state; offline adds the tiles-unavailable line; the canvas is hidden from assistive tech', async () => {
    const { rerender } = await render(<HazardMap pins={pins} center={PILOT.center} selectedId={null} onSelect={() => {}} offline={false} height={300} />);
    expect(screen.getByText('© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors')).toBeTruthy();
    expect(screen.queryByText(/Map tiles unavailable offline/)).toBeNull();
    await rerender(<HazardMap pins={pins} center={PILOT.center} selectedId={null} onSelect={() => {}} offline height={300} />);
    expect(screen.getByText('Map tiles unavailable offline · showing saved reports')).toBeTruthy();
    expect(screen.getByText('© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors')).toBeTruthy();
    expect(screen.getByTestId('hazard-map-canvas', hidden).props.accessibilityElementsHidden).toBe(true);
    // Pins still render without tiles (plan §23.F test wording).
    expect(screen.getAllByTestId(/^mlrn-feature-/, hidden)).toHaveLength(reports.length);
  });

  test('an empty feed renders no pins and no crash', async () => {
    await render(<HazardMap pins={[]} center={PILOT.center} selectedId={null} onSelect={() => {}} offline={false} height={300} />);
    expect(screen.queryAllByTestId(/^mlrn-feature-/, hidden)).toHaveLength(0);
  });
});

describe('shared layer helpers', () => {
  test('toPins keeps exactly the fields the map needs; pinsToGeoJSON emits [lng, lat] points keyed by report id', () => {
    const r = reports[0]!;
    expect(pins[0]).toEqual({ id: r.id, lat: r.lat, lng: r.lng, severity: r.severity, voteCount: r.voteCount, title: r.title, status: r.status, category: r.category });
    const fc = pinsToGeoJSON(pins);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(pins.length);
    expect(fc.features[0]).toMatchObject({ type: 'Feature', id: r.id, geometry: { type: 'Point', coordinates: [r.lng, r.lat] }, properties: { id: r.id, severity: r.severity, voteCount: r.voteCount, title: r.title } });
    expect((fc.features[0]!.properties as Record<string, unknown>).lat).toBeUndefined();
  });

  test('pin colour follows the severity tones; radius is anchored at the vote thresholds; the selected pin gets the dark ring', () => {
    const paint = pinPaint('demo-wo-0418');
    expect(paint['circle-color']).toEqual(['match', ['get', 'severity'], 1, toneColor[severityTone[1]], 2, toneColor[severityTone[2]], 3, toneColor[severityTone[3]], 4, toneColor[severityTone[4]], toneColor.grey]);
    expect(paint['circle-radius']).toEqual(['interpolate', ['linear'], ['get', 'voteCount'], 0, PIN_RADIUS.none, VOTE_THRESHOLDS.supervisorReview, PIN_RADIUS.review, VOTE_THRESHOLDS.councilItem, PIN_RADIUS.council]);
    expect(paint['circle-stroke-color']).toEqual(['case', ['==', ['get', 'id'], 'demo-wo-0418'], colors.ink, colors.white]);
    expect(pinPaint(null)['circle-stroke-color']).toEqual(['case', ['==', ['get', 'id'], ''], colors.ink, colors.white]);
  });

  test('clusters merge within 40 px and are coloured by their worst severity', () => {
    expect(CLUSTER.radius).toBe(40);
    expect(CLUSTER.properties).toEqual({ maxSeverity: ['max', ['get', 'severity']] });
  });
});
