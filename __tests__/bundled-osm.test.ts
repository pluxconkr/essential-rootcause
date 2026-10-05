/**
 * The bundled OpenStreetMap extract (assets/data/osm/new-brunswick-nj.json; plan §8, docs/data-sources.md §1):
 * parses with the domain schema, covers the pilot bbox and nothing far outside it, carries the ODbL attribution,
 * is deterministic (sorted ids) and small enough to ship — and a hand-made sample cannot pass as a real extract.
 */
import { statSync } from 'fs';
import { join } from 'path';

import { OSM_ATTRIBUTION, OSM_DATA_VERSION, OsmDataSchema, PEDS_BY_ROAD_CLASS, POI_KINDS } from '@/domain/exposure';
import { inBBox, metresPerDegree } from '@/domain/geo';
import { PILOT_BBOX } from '@/domain/pilot';

import raw from '../assets/data/osm/new-brunswick-nj.json';

const FILE = join(__dirname, '..', 'assets', 'data', 'osm', 'new-brunswick-nj.json');
const MAX_BYTES = 3 * 1024 * 1024; // ships inside the app and the server bundle
/** scripts/build-osm.ts lets road vertices run this far past the bbox so edge segments stay whole. */
const ROAD_BUFFER_M = 250;

const data = OsmDataSchema.parse(raw);

describe('bundled OSM extract', () => {
  test('has the documented shape and version', () => {
    expect(OsmDataSchema.safeParse(raw).success).toBe(true);
    expect(data.version).toBe(OSM_DATA_VERSION);
    expect(Number.isFinite(Date.parse(data.fetchedAt))).toBe(true);
    expect(data.attribution).toBe(OSM_ATTRIBUTION);
    expect(data.attribution).toMatch(/OpenStreetMap contributors/);
    expect(data.attribution).toMatch(/ODbL/);
  });

  test('is anchored on the pilot bbox: points inside it, road vertices at most a short buffer outside', () => {
    for (const k of ['minLat', 'minLng', 'maxLat', 'maxLng'] as const) expect(data.bbox[k]).toBeCloseTo(PILOT_BBOX[k], 6);
    for (const p of data.pois) expect(inBBox(p, data.bbox)).toBe(true);
    for (const a of data.addresses) expect(inBBox(a, data.bbox)).toBe(true);
    const m = metresPerDegree((data.bbox.minLat + data.bbox.maxLat) / 2);
    const buffered = { minLat: data.bbox.minLat - ROAD_BUFFER_M / m.lat, maxLat: data.bbox.maxLat + ROAD_BUFFER_M / m.lat, minLng: data.bbox.minLng - ROAD_BUFFER_M / m.lng, maxLng: data.bbox.maxLng + ROAD_BUFFER_M / m.lng };
    for (const r of data.roads) for (const [lng, lat] of r.points) expect(inBBox({ lat, lng }, buffered)).toBe(true);
  });

  test('roads carry a name and a class from the pedestrian table; POIs a known kind; addresses a number and street', () => {
    for (const r of data.roads) {
      expect(r.name.trim().length).toBeGreaterThan(0);
      expect(Object.keys(PEDS_BY_ROAD_CLASS)).toContain(r.class);
    }
    for (const p of data.pois) expect(POI_KINDS).toContain(p.kind);
    for (const a of data.addresses) {
      expect(a.number.trim().length).toBeGreaterThan(0);
      expect(a.street.trim().length).toBeGreaterThan(0);
    }
  });

  test('is deterministic: ids ascend, addresses are unique per (street, number), coordinates are rounded', () => {
    for (let i = 1; i < data.roads.length; i++) expect(data.roads[i].id).toBeGreaterThan(data.roads[i - 1].id);
    for (let i = 1; i < data.pois.length; i++) expect(data.pois[i].id).toBeGreaterThan(data.pois[i - 1].id);
    const keys = data.addresses.map((a) => `${a.street.toLowerCase()}|${a.number.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
    const decimals = (n: number) => (String(n).split('.')[1] ?? '').length;
    for (const p of data.pois.slice(0, 50)) expect(Math.max(decimals(p.lat), decimals(p.lng))).toBeLessThanOrEqual(5);
  });

  test('sample flag honesty: a real extract is big, dated by Overpass and unflagged; a sample says so', () => {
    if (data.sample) {
      expect(data.note ?? '').toMatch(/sample/i);
      expect(data.osmTimestamp).toBeNull();
    } else {
      expect(data.sample).toBeUndefined();
      expect(data.osmTimestamp).not.toBeNull();
      expect(Number.isFinite(Date.parse(data.osmTimestamp ?? ''))).toBe(true);
      expect(data.roads.length).toBeGreaterThanOrEqual(100);
      expect(data.addresses.length).toBeGreaterThanOrEqual(100);
      expect(data.pois.filter((p) => p.kind === 'school').length).toBeGreaterThanOrEqual(5);
      expect(data.pois.filter((p) => p.kind === 'transit').length).toBeGreaterThanOrEqual(5);
    }
  });

  test('fits the shipping budget', () => {
    expect(statSync(FILE).size).toBeLessThan(MAX_BYTES);
  });
});
