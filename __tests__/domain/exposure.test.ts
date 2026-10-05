/**
 * exposure.ts — the pedestrians/day table from plan §8, segment-based road matching, POI flags within 200 m, the
 * address rule (same street preferred → "<road> near <cross street>" → coordinates), and the same functions against
 * the bundled New Brunswick extract: a point on George Street gets its class and figure, a point by New Brunswick
 * High School gets the school flag, and the address keeps the street the spot is on.
 */
import { ADDRESS_SEARCH_M, EXPOSURE_SOURCE_NOTE, NO_ROAD_PEDS, OsmDataSchema, PEDS_BY_ROAD_CLASS, POI_RADIUS_M, ROAD_SEARCH_M, approximateAddress, coveredBy, distanceToRoadM, distanceToSegmentM, exposureInputs, nearestRoad, type OsmAddress, type OsmData, type OsmPoi, type OsmRoad } from '@/domain/exposure';
import { distanceM, metresPerDegree, type LatLng } from '@/domain/geo';

import bundled from '../../assets/data/osm/new-brunswick-nj.json';

const origin: LatLng = { lat: 40.4862, lng: -74.4518 };
const m = metresPerDegree(origin.lat);
/** A point `east` metres east and `north` metres north of the origin. */
const at = (east: number, north: number): LatLng => ({ lat: origin.lat + north / m.lat, lng: origin.lng + east / m.lng });
const pt = (p: LatLng): [number, number] => [p.lng, p.lat];

/** Main Street runs west→east along north = 0 with vertices 300 m apart; Side Street crosses it going north at east = 0. */
const main: OsmRoad = { id: 1, name: 'Main Street', class: 'tertiary', points: [pt(at(-300, 0)), pt(at(0, 0)), pt(at(300, 0))] };
const side: OsmRoad = { id: 2, name: 'Side Street', class: 'residential', points: [pt(at(0, 0)), pt(at(0, 400))] };
const far: OsmRoad = { id: 3, name: 'Far Avenue', class: 'primary', points: [pt(at(-200, 900)), pt(at(200, 900))] };
const roads = [main, side, far];

describe('pedestrian table (plan §8)', () => {
  test('every class carries the plan figure', () => {
    expect(PEDS_BY_ROAD_CLASS).toEqual({ primary: 4000, secondary: 2500, tertiary: 1500, residential: 600, living_street: 400, footway: 1200, pedestrian: 1200, path: 200, service: 150, motorway: 0, trunk: 0, unclassified: 400 });
    expect(POI_RADIUS_M).toBe(200);
    expect(NO_ROAD_PEDS).toBe(PEDS_BY_ROAD_CLASS.path);
    expect(EXPOSURE_SOURCE_NOTE).toBe('estimated from map data');
  });
});

describe('road matching', () => {
  test('distance to a segment: on the line → 0, beside its middle → the offset, beyond an end → distance to that end', () => {
    expect(distanceToSegmentM(at(100, 0), at(-300, 0), at(300, 0))).toBeLessThan(0.5);
    expect(distanceToSegmentM(at(150, 12), at(-300, 0), at(300, 0))).toBeCloseTo(12, 0);
    expect(distanceToSegmentM(at(400, 0), at(-300, 0), at(300, 0))).toBeCloseTo(100, 0);
    expect(distanceToRoadM(at(0, 200), side)).toBeLessThan(0.5);
  });

  test('a mid-block point 150 m from every vertex still matches its own street, not the cross street', () => {
    const p = at(150, 6); // on Main Street between two vertices, 6 m off the line
    const near = nearestRoad(p, roads);
    expect(near?.road.name).toBe('Main Street');
    expect(near?.distanceM).toBeCloseTo(6, 0);
    expect(distanceM(p, { lng: main.points[1][0], lat: main.points[1][1] })).toBeGreaterThan(140); // vertex-only matching would have missed it
    expect(nearestRoad(p, [])).toBeNull();
    expect(nearestRoad(at(0, 350), roads)?.road.name).toBe('Side Street');
  });
});

describe('exposureInputs', () => {
  const school: OsmPoi = { id: 10, kind: 'school', name: 'Lincoln Annex', ...at(120, 150) }; // ≈ 192 m from the origin
  const senior: OsmPoi = { id: 11, kind: 'senior', name: null, ...at(0, 260) }; // 260 m: outside the radius
  const stop: OsmPoi = { id: 12, kind: 'transit', name: 'Main at Side', ...at(-40, 10) };
  const data = { roads, pois: [school, senior, stop] };

  test('road class → pedestrians/day plus POI flags within 200 m, labelled as an estimate', () => {
    const r = exposureInputs(at(20, 2), data);
    expect(r).toEqual({ pedsPerDay: 1500, flags: { schoolRoute: true, seniorFacility: false, transitStop: true }, roadName: 'Main Street', roadClass: 'tertiary', roadDistanceM: 2, sourceNote: 'estimated from map data' });
    expect(distanceM(at(20, 2), school)).toBeLessThanOrEqual(POI_RADIUS_M);
    expect(distanceM(at(20, 2), senior)).toBeGreaterThan(POI_RADIUS_M);
  });

  test('off the network (farther than ROAD_SEARCH_M from every road) → the path figure and no road', () => {
    const p = at(-250, 500);
    expect(nearestRoad(p, roads)!.distanceM).toBeGreaterThan(ROAD_SEARCH_M);
    expect(exposureInputs(p, data)).toMatchObject({ pedsPerDay: NO_ROAD_PEDS, roadName: null, roadClass: null, roadDistanceM: null });
    expect(exposureInputs(p, { roads: [], pois: [] }).flags).toEqual({ schoolRoute: false, seniorFacility: false, transitStop: false });
  });
});

describe('approximateAddress', () => {
  const onMain: OsmAddress = { number: '120', street: 'Main Street', ...at(130, 14) };
  const onSide: OsmAddress = { number: '7', street: 'Side Street', ...at(104, 8) };
  const elsewhere: OsmAddress = { number: '1', street: 'Far Avenue', ...at(0, 880) };

  test('prefers an address on the street the spot is on over a closer one on another street', () => {
    const p = at(100, 3); // on Main Street; 7 Side Street is ~6 m away, 120 Main Street ~32 m
    expect(distanceM(p, onSide)).toBeLessThan(distanceM(p, onMain));
    expect(approximateAddress(p, { roads, addresses: [onMain, onSide, elsewhere] })).toEqual({ text: '120 Main Street', confidence: 'approx' });
    expect(approximateAddress(p, { roads, addresses: [onSide] })).toEqual({ text: '7 Side Street', confidence: 'approx' });
    expect(distanceM(p, elsewhere)).toBeGreaterThan(ADDRESS_SEARCH_M);
  });

  test('without an address point: "<road> near <cross street>", the road alone, then rounded coordinates', () => {
    expect(approximateAddress(at(60, 2), { roads, addresses: [] })).toEqual({ text: 'Main Street near Side Street', confidence: 'approx' });
    expect(approximateAddress(at(0, 890), { roads, addresses: [] })).toEqual({ text: 'Far Avenue', confidence: 'approx' });
    const nowhere = at(-900, -900);
    expect(approximateAddress(nowhere, { roads, addresses: [] })).toEqual({ text: `${nowhere.lat.toFixed(4)}, ${nowhere.lng.toFixed(4)}`, confidence: 'approx' });
  });
});

describe('against the bundled New Brunswick extract', () => {
  const data: OsmData = OsmDataSchema.parse(bundled);
  /** Midpoint of the longest segment of the longest George Street way — well away from any intersection. */
  const george = data.roads.filter((r) => r.name === 'George Street').sort((a, b) => b.points.length - a.points.length)[0];
  const georgePoint = (() => {
    let best: { d: number; p: LatLng } | null = null;
    for (let i = 1; i < george.points.length; i++) {
      const a = { lng: george.points[i - 1][0], lat: george.points[i - 1][1] };
      const b = { lng: george.points[i][0], lat: george.points[i][1] };
      const d = distanceM(a, b);
      if (!best || d > best.d) best = { d, p: { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 } };
    }
    return best!.p;
  })();

  test('a point on George Street gets its class and the matching pedestrian figure', () => {
    expect(george).toBeDefined();
    const r = exposureInputs(georgePoint, data);
    expect(r.roadName).toBe('George Street');
    expect(r.roadClass).toBe(george.class);
    expect(r.pedsPerDay).toBe(PEDS_BY_ROAD_CLASS[george.class]);
    expect(r.roadDistanceM).toBeLessThanOrEqual(2);
    expect(r.sourceNote).toBe('estimated from map data');
    expect(coveredBy(georgePoint, data)).toBe(true);
  });

  test('a point beside New Brunswick High School carries the school flag; the middle of the Raritan does not', () => {
    const school = data.pois.find((p) => p.kind === 'school' && /New Brunswick High School/i.test(p.name ?? ''));
    expect(school).toBeDefined();
    const beside = { lat: school!.lat + 30 / m.lat, lng: school!.lng };
    expect(exposureInputs(beside, data).flags.schoolRoute).toBe(true);
    const noSchool = data.pois.filter((p) => p.kind === 'school').every((p) => distanceM(georgePoint, p) > POI_RADIUS_M);
    expect(exposureInputs(georgePoint, data).flags.schoolRoute).toBe(!noSchool);
  });

  test('the approximate address of a George Street point names George Street', () => {
    const a = approximateAddress(georgePoint, data);
    expect(a.confidence).toBe('approx');
    expect(a.text).toMatch(/George Street/);
  });
});
