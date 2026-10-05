/**
 * Exposure proxy and approximate reverse-geocoding over the bundled OpenStreetMap extract (plan §8 "Exposure data",
 * docs/data-sources.md §1). Pure module: no React Native or Expo imports — the server calls it at intake
 * (src/server/exposure.ts), tests call it against the bundled file, and the phone could call it offline.
 *
 * The pedestrians/day figures are placeholders keyed by OSM road class, not counts; every result carries
 * `sourceNote: 'estimated from map data'` so the term is never shown as a measurement. Replace the table with the
 * city's counts when the pilot provides them. A road is matched by distance to its nearest segment (the extract keeps
 * every third node, so vertices alone can be hundreds of metres apart on a street grid); POIs and address points
 * are matched with geo.distanceM.
 */
import { z } from 'zod';

import { distanceM, metresPerDegree, type BBox, type LatLng } from './geo';

/** Pedestrians per day by OSM highway class. plan §8: primary 4000 … service 150; motorway/trunk 0; unclassified 400. */
export const PEDS_BY_ROAD_CLASS = {
  primary: 4000, // plan §8
  secondary: 2500, // plan §8
  tertiary: 1500, // plan §8
  residential: 600, // plan §8
  living_street: 400, // plan §8
  footway: 1200, // plan §8 "footway/pedestrian 1200"
  pedestrian: 1200, // plan §8 "footway/pedestrian 1200"
  path: 200, // plan §8
  service: 150, // plan §8
  motorway: 0, // plan §8 — no pedestrians
  trunk: 0, // plan §8 — no pedestrians
  unclassified: 400, // plan §8
} as const;
export type RoadClass = keyof typeof PEDS_BY_ROAD_CLASS;
export const ROAD_CLASSES = Object.keys(PEDS_BY_ROAD_CLASS) as [RoadClass, ...RoadClass[]];

export const POI_RADIUS_M = 200; // plan §8 "POIs within 200 m"
/** A report farther than this from every named road is off the network: it gets the `path` figure, and no road name. */
export const ROAD_SEARCH_M = 100;
/** Address points count only this close — about one lot either side of the spot. */
export const ADDRESS_SEARCH_M = 75;
/** How far to look for the cross street in "<road> near <cross street>". */
export const CROSS_STREET_SEARCH_M = 150;
export const NO_ROAD_PEDS: number = PEDS_BY_ROAD_CLASS.path; // off-network spots (parks, lots) are treated as a path
export const EXPOSURE_SOURCE_NOTE = 'estimated from map data'; // plan §8 label

export const POI_KINDS = ['school', 'senior', 'transit'] as const;
export type PoiKind = (typeof POI_KINDS)[number];

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';
/** Bump when the file shape changes; the server refuses files it cannot parse and falls back to EMPTY_OSM_DATA. */
export const OSM_DATA_VERSION = 1;

// ---------- File shape (written by scripts/build-osm.ts, read by src/server/exposure.ts) ----------

/** A named way with a highway class. `points` are [lng, lat] pairs (GeoJSON order), every third OSM node kept. */
export const OsmRoadSchema = z.object({
  id: z.number(),
  name: z.string().min(1),
  class: z.enum(ROAD_CLASSES),
  points: z.array(z.tuple([z.number(), z.number()])).min(1),
});
export type OsmRoad = z.infer<typeof OsmRoadSchema>;

export const OsmPoiSchema = z.object({
  id: z.number(),
  kind: z.enum(POI_KINDS),
  name: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
});
export type OsmPoi = z.infer<typeof OsmPoiSchema>;

export const OsmAddressSchema = z.object({
  number: z.string().min(1),
  street: z.string().min(1),
  lat: z.number(),
  lng: z.number(),
});
export type OsmAddress = z.infer<typeof OsmAddressSchema>;

export const OsmDataSchema = z.object({
  version: z.number().int(),
  /** When the script ran (ISO). */
  fetchedAt: z.string(),
  /** Overpass `osm3s.timestamp_osm_base`; null for a hand-made sample. */
  osmTimestamp: z.string().nullable(),
  bbox: z.object({ minLat: z.number(), minLng: z.number(), maxLat: z.number(), maxLng: z.number() }),
  /** True only for a hand-made placeholder file; `note` then says so. Never set by the build script. */
  sample: z.boolean().optional(),
  note: z.string().optional(),
  roads: z.array(OsmRoadSchema),
  pois: z.array(OsmPoiSchema),
  addresses: z.array(OsmAddressSchema),
  attribution: z.literal(OSM_ATTRIBUTION),
});
export type OsmData = z.infer<typeof OsmDataSchema>;

/** What the server uses when the bundled file is missing or invalid: every lookup degrades to the off-network defaults. */
export const EMPTY_OSM_DATA: OsmData = {
  version: OSM_DATA_VERSION,
  fetchedAt: '1970-01-01T00:00:00.000Z',
  osmTimestamp: null,
  bbox: { minLat: 0, minLng: 0, maxLat: 0, maxLng: 0 },
  roads: [],
  pois: [],
  addresses: [],
  attribution: OSM_ATTRIBUTION,
};

// ---------- Geometry ----------

/** Distance from `p` to the segment a–b in metres on a flat local projection (accurate to well under 1 % at these scales). */
export function distanceToSegmentM(p: LatLng, a: LatLng, b: LatLng): number {
  const m = metresPerDegree(p.lat);
  const ax = (a.lng - p.lng) * m.lng;
  const ay = (a.lat - p.lat) * m.lat;
  const bx = (b.lng - p.lng) * m.lng;
  const by = (b.lat - p.lat) * m.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Distance from `p` to a road's polyline; a single-vertex road is just that point. */
export function distanceToRoadM(p: LatLng, road: OsmRoad): number {
  const pts = road.points;
  if (pts.length === 1) return distanceM(p, { lng: pts[0][0], lat: pts[0][1] });
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = distanceToSegmentM(p, { lng: pts[i - 1][0], lat: pts[i - 1][1] }, { lng: pts[i][0], lat: pts[i][1] });
    if (d < best) best = d;
  }
  return best;
}

export interface NearestRoad {
  road: OsmRoad;
  distanceM: number;
}

/** The road whose polyline passes closest to `point`, or null when there are no roads. */
export function nearestRoad(point: LatLng, roads: readonly OsmRoad[], exclude?: (road: OsmRoad) => boolean): NearestRoad | null {
  let best: NearestRoad | null = null;
  for (const road of roads) {
    if (exclude?.(road)) continue;
    const d = distanceToRoadM(point, road);
    if (!best || d < best.distanceM) best = { road, distanceM: d };
  }
  return best;
}

// ---------- Exposure inputs ----------

export interface ExposureFlagsV1 {
  schoolRoute: boolean;
  seniorFacility: boolean;
  transitStop: boolean;
}

/** Stored on report.exposure_terms at intake and re-read by the nightly recompute (src/server/jobs/recompute.ts). */
export interface ExposureInputs {
  pedsPerDay: number;
  flags: ExposureFlagsV1;
  roadName: string | null;
  roadClass: RoadClass | null;
  /** Whole metres from the spot to the matched road; null when off the network. */
  roadDistanceM: number | null;
  sourceNote: typeof EXPOSURE_SOURCE_NOTE;
}

/** Road class → pedestrians/day, plus the vulnerable-population flags from POIs within POI_RADIUS_M (plan §8). */
export function exposureInputs(point: LatLng, data: Pick<OsmData, 'roads' | 'pois'>): ExposureInputs {
  const near = nearestRoad(point, data.roads);
  const onRoad = near !== null && near.distanceM <= ROAD_SEARCH_M;
  const flags: ExposureFlagsV1 = { schoolRoute: false, seniorFacility: false, transitStop: false };
  for (const poi of data.pois) {
    if (distanceM(point, poi) > POI_RADIUS_M) continue;
    if (poi.kind === 'school') flags.schoolRoute = true;
    else if (poi.kind === 'senior') flags.seniorFacility = true;
    else flags.transitStop = true;
  }
  return {
    pedsPerDay: onRoad ? PEDS_BY_ROAD_CLASS[near.road.class] : NO_ROAD_PEDS,
    flags,
    roadName: onRoad ? near.road.name : null,
    roadClass: onRoad ? near.road.class : null,
    roadDistanceM: onRoad ? Math.round(near.distanceM) : null,
    sourceNote: EXPOSURE_SOURCE_NOTE,
  };
}

// ---------- Approximate address ----------

export interface ApproximateAddress {
  text: string;
  /** Always approximate: the resident may edit it, and the server stores address_confidence = 'approx'. */
  confidence: 'approx';
}

export function normalizeStreet(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Nearest address point within ADDRESS_SEARCH_M, preferring one on the road the spot is on; else
 * "<road name> near <cross street>" (or the road alone); else the coordinates rounded to ~10 m.
 */
export function approximateAddress(point: LatLng, data: Pick<OsmData, 'roads' | 'addresses'>): ApproximateAddress {
  const near = nearestRoad(point, data.roads);
  const roadName = near !== null && near.distanceM <= ROAD_SEARCH_M ? near.road.name : null;
  const roadKey = roadName === null ? null : normalizeStreet(roadName);

  let best: { addr: OsmAddress; d: number } | null = null;
  let bestSameStreet: { addr: OsmAddress; d: number } | null = null;
  for (const addr of data.addresses) {
    const d = distanceM(point, addr);
    if (d > ADDRESS_SEARCH_M) continue;
    if (!best || d < best.d) best = { addr, d };
    if (roadKey !== null && normalizeStreet(addr.street) === roadKey && (!bestSameStreet || d < bestSameStreet.d)) bestSameStreet = { addr, d };
  }
  const pick = bestSameStreet ?? best;
  if (pick) return { text: `${pick.addr.number} ${pick.addr.street.trim()}`, confidence: 'approx' };

  if (roadName !== null && roadKey !== null) {
    const cross = nearestRoad(point, data.roads, (r) => normalizeStreet(r.name) === roadKey);
    const crossName = cross !== null && cross.distanceM <= CROSS_STREET_SEARCH_M ? cross.road.name : null;
    return { text: crossName ? `${roadName} near ${crossName}` : roadName, confidence: 'approx' };
  }

  return { text: `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`, confidence: 'approx' };
}

/** True when the point lies inside the extract's bbox — outside it every lookup is a guess about another town. */
export function coveredBy(point: LatLng, data: Pick<OsmData, 'bbox'>): boolean {
  const b: BBox = data.bbox;
  return point.lat >= b.minLat && point.lat <= b.maxLat && point.lng >= b.minLng && point.lng <= b.maxLng;
}
