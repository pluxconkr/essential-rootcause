/**
 * geo.ts — distance, bbox parsing, and the deterministic 50 m snap + jitter behind public points (spec §12/§13, plan §14).
 */
import { bboxAround, distanceM, fnv1a, inBBox, jitter, metresPerDegree, parseBBox, publicPoint, snapToGrid } from '@/domain/geo';

const nb = { lat: 40.4862, lng: -74.4518 };

describe('distanceM', () => {
  test('zero for the same point, ~111.2 km per degree of latitude, symmetric', () => {
    expect(distanceM(nb, nb)).toBe(0);
    expect(distanceM(nb, { lat: nb.lat + 1, lng: nb.lng })).toBeCloseTo(111_195, -2);
    expect(distanceM(nb, { lat: 40.7128, lng: -74.006 })).toBeCloseTo(distanceM({ lat: 40.7128, lng: -74.006 }, nb), 6);
    expect(distanceM(nb, { lat: 40.7128, lng: -74.006 })).toBeGreaterThan(40_000); // New Brunswick → Manhattan ≈ 45 km
    expect(distanceM(nb, { lat: 40.7128, lng: -74.006 })).toBeLessThan(50_000);
  });
});

describe('bbox', () => {
  test('bboxAround contains the centre and nearby points, not far ones', () => {
    const b = bboxAround(nb, 1000);
    expect(inBBox(nb, b)).toBe(true);
    expect(inBBox({ lat: nb.lat + 500 / metresPerDegree(nb.lat).lat, lng: nb.lng }, b)).toBe(true);
    expect(inBBox({ lat: nb.lat + 2000 / metresPerDegree(nb.lat).lat, lng: nb.lng }, b)).toBe(false);
  });

  test('parseBBox reads minLng,minLat,maxLng,maxLat and rejects bad input', () => {
    expect(parseBBox('-74.5,40.4,-74.4,40.5')).toEqual({ minLng: -74.5, minLat: 40.4, maxLng: -74.4, maxLat: 40.5 });
    expect(parseBBox(null)).toBeNull();
    expect(parseBBox('')).toBeNull();
    expect(parseBBox('1,2,3')).toBeNull();
    expect(parseBBox('a,b,c,d')).toBeNull();
    expect(parseBBox('-74.4,40.5,-74.5,40.4')).toBeNull();
  });
});

describe('fnv1a', () => {
  test('known vectors and determinism', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('demo-wo-0418')).toBe(fnv1a('demo-wo-0418'));
    expect(fnv1a('demo-wo-0418')).not.toBe(fnv1a('demo-wo-0419'));
  });
});

describe('snapToGrid', () => {
  test('deterministic, within half a cell diagonal, and points in the same cell land together', () => {
    const a = snapToGrid(nb);
    expect(snapToGrid(nb)).toEqual(a);
    expect(distanceM(nb, a)).toBeLessThanOrEqual(36); // half of a 50 m cell's diagonal ≈ 35.4 m
    const m = metresPerDegree(nb.lat);
    expect(snapToGrid({ lat: nb.lat, lng: a.lng + 1 / m.lng })).toEqual(a); // same row as nb, 1 m from the node → same node
    // The cell width is derived from the point's own latitude, so a point on the next row can land on a node a few metres
    // off this one (not a true grid across rows) — still inside the 50 m coarsening radius, which is all §12 needs.
    expect(distanceM(snapToGrid({ lat: a.lat + 3 / m.lat, lng: a.lng }), a)).toBeLessThan(50);
    const cellLat = 50 / m.lat;
    expect(a.lat / cellLat).toBeCloseTo(Math.round(a.lat / cellLat), 6);
  });

  test('custom cell size', () => {
    const coarse = snapToGrid(nb, 500);
    expect(distanceM(nb, coarse)).toBeLessThanOrEqual(354);
  });
});

describe('jitter', () => {
  test('same seed → same point; different seed → different point; never farther than maxM', () => {
    const a = jitter(nb, 'r1');
    expect(jitter(nb, 'r1')).toEqual(a);
    expect(jitter(nb, 'r2')).not.toEqual(a);
    for (const seed of ['r1', 'r2', 'r3', 'abc', 'demo-wo-0418']) {
      expect(distanceM(nb, jitter(nb, seed))).toBeLessThanOrEqual(50.01);
      expect(distanceM(nb, jitter(nb, seed, 10))).toBeLessThanOrEqual(10.01);
    }
  });
});

describe('publicPoint', () => {
  test('anonymous reports keep the precise point', () => {
    expect(publicPoint(nb, 'r1', false)).toEqual(nb);
  });

  test('reporter-linked reports are snapped then jittered: stable per id, moved but within ~86 m', () => {
    const p = publicPoint(nb, 'r1', true);
    expect(publicPoint(nb, 'r1', true)).toEqual(p);
    expect(p).not.toEqual(nb);
    expect(distanceM(nb, p)).toBeLessThanOrEqual(86);
    expect(publicPoint(nb, 'r2', true)).not.toEqual(p);
    expect(publicPoint(nb, 'r1', true)).toEqual(jitter(snapToGrid(nb), 'r1'));
  });
});
