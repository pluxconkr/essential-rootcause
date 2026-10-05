/**
 * Geometry helpers shared by the phone, the API and the tests. Distances are straight-line (haversine);
 * public points for reporter-linked reports are snapped to a 50 m grid and jittered deterministically so the
 * same report always lands on the same public point (spec §13 "public map jitters reporter-linked points").
 * Pure module.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface BBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

const EARTH_M = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;

export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Metres per degree at this latitude. */
export function metresPerDegree(lat: number): { lat: number; lng: number } {
  return { lat: 111_320, lng: Math.max(1, 111_320 * Math.cos(toRad(lat))) };
}

export function bboxAround(center: LatLng, radiusM: number): BBox {
  const m = metresPerDegree(center.lat);
  return { minLat: center.lat - radiusM / m.lat, maxLat: center.lat + radiusM / m.lat, minLng: center.lng - radiusM / m.lng, maxLng: center.lng + radiusM / m.lng };
}

export function inBBox(p: LatLng, b: BBox): boolean {
  return p.lat >= b.minLat && p.lat <= b.maxLat && p.lng >= b.minLng && p.lng <= b.maxLng;
}

/** Parse "minLng,minLat,maxLng,maxLat" (the GeoJSON/Open311 order). */
export function parseBBox(s: string | null | undefined): BBox | null {
  if (!s) return null;
  const n = s.split(',').map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return null;
  const [minLng, minLat, maxLng, maxLat] = n as [number, number, number, number];
  if (minLat > maxLat || minLng > maxLng) return null;
  return { minLat, minLng, maxLat, maxLng };
}

/** FNV-1a 32-bit hash; deterministic seeds for jitter and demo data. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Snap to a grid of `cellM` metres (the day-30 coarsening of anonymous reports, spec §12). */
export function snapToGrid(p: LatLng, cellM = 50): LatLng {
  const m = metresPerDegree(p.lat);
  const cellLat = cellM / m.lat;
  const cellLng = cellM / m.lng;
  return { lat: Math.round(p.lat / cellLat) * cellLat, lng: Math.round(p.lng / cellLng) * cellLng };
}

/** Deterministic jitter of up to `maxM` metres seeded by `seed` (the report id). Same input → same output. */
export function jitter(p: LatLng, seed: string, maxM = 50): LatLng {
  const h = fnv1a(seed);
  const angle = ((h & 0xffff) / 0xffff) * 2 * Math.PI;
  const dist = ((h >>> 16) / 0xffff) * maxM;
  const m = metresPerDegree(p.lat);
  return { lat: p.lat + (Math.sin(angle) * dist) / m.lat, lng: p.lng + (Math.cos(angle) * dist) / m.lng };
}

/** Public point for a report: reporter-linked → snapped then jittered; anonymous → precise (spec §13). */
export function publicPoint(p: LatLng, reportId: string, reporterLinked: boolean): LatLng {
  return reporterLinked ? jitter(snapToGrid(p), reportId) : p;
}
