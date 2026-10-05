/**
 * Build the bundled OpenStreetMap extract for the pilot area (plan §8 "Exposure data"; docs/data-sources.md §1):
 * named roads with a highway class (every third node kept), schools / senior facilities / transit stops as POIs,
 * and address points — written to assets/data/osm/<pilot slug>.json in the shape src/domain/exposure.ts reads.
 *
 * Overpass is asked twice (roads with geometry; POIs and addresses with centres), politely: one request at a time,
 * an identifiable User-Agent, retries with backoff on the "server too busy" / 429 / 504 answers. The output is
 * deterministic for a given OSM state: sorted ids, coordinates rounded to 5 decimals (≈ 1 m), points clipped to the
 * pilot bbox. Node script, never bundled into the app.
 *
 *   npx tsx scripts/build-osm.ts              # writes assets/data/osm/new-brunswick-nj.json (run from the repo root)
 *   npx tsx scripts/build-osm.ts --out <file> # elsewhere
 *
 * © OpenStreetMap contributors, ODbL 1.0 — the extract is a derivative database and keeps the attribution field.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

import { OSM_ATTRIBUTION, OSM_DATA_VERSION, PEDS_BY_ROAD_CLASS, type OsmAddress, type OsmData, type OsmPoi, type OsmRoad, type RoadClass } from '../src/domain/exposure';
import { inBBox, metresPerDegree, type BBox } from '../src/domain/geo';
import { PILOT, PILOT_BBOX } from '../src/domain/pilot';

const CONFIG = {
  endpoint: 'https://overpass-api.de/api/interpreter', // docs/data-sources.md §1
  userAgent: 'RootCause-build/1.0 (https://github.com/justiceserv/rootcause; scripts/build-osm.ts)', // Overpass asks for an identifiable UA
  queryTimeoutSec: 180,
  attempts: 6, // "server too busy" is common; wait and retry
  backoffMs: 20_000,
  pauseBetweenQueriesMs: 3_000, // one request at a time, with a breath in between
  simplifyEvery: 3, // plan §8 task: keep every 3rd node (plus first and last)
  coordDecimals: 5, // ≈ 1 m
  /** Road vertices may run this far past the bbox so edge segments stay intact; POIs and addresses are clipped exactly. */
  roadBufferM: 250,
  /** Only these highway classes are kept (plan §8 table). */
  roadClasses: ['primary', 'secondary', 'tertiary', 'residential', 'living_street', 'footway', 'pedestrian', 'path', 'service', 'unclassified'] as const satisfies readonly RoadClass[],
} as const;

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

interface OverpassResponse {
  osm3s?: { timestamp_osm_base?: string };
  elements: OverpassElement[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (n: number) => Number(n.toFixed(CONFIG.coordDecimals));

/** "(south,west,north,east)" — the Overpass bbox order. */
function overpassBBox(b: BBox): string {
  return `(${b.minLat},${b.minLng},${b.maxLat},${b.maxLng})`;
}

function roadsQuery(b: BBox): string {
  const classes = CONFIG.roadClasses.join('|');
  return `[out:json][timeout:${CONFIG.queryTimeoutSec}];way["highway"~"^(${classes})$"]["name"]${overpassBBox(b)};out geom;`;
}

function placesQuery(b: BBox): string {
  const bb = overpassBBox(b);
  const selectors = [
    `node["amenity"="school"]${bb}`,
    `way["amenity"="school"]${bb}`,
    `node["social_facility"~"^(nursing_home|assisted_living)$"]${bb}`,
    `way["social_facility"~"^(nursing_home|assisted_living)$"]${bb}`,
    `node["highway"="bus_stop"]${bb}`,
    `node["railway"~"^(station|tram_stop)$"]${bb}`,
    `way["railway"~"^(station|tram_stop)$"]${bb}`,
    `node["public_transport"="platform"]${bb}`,
    `way["public_transport"="platform"]${bb}`,
    `node["addr:housenumber"]["addr:street"]${bb}`,
    `way["addr:housenumber"]["addr:street"]${bb}`,
  ];
  return `[out:json][timeout:${CONFIG.queryTimeoutSec}];(${selectors.join(';')};);out center;`;
}

/** GET with the query in the URL (the form the public instance answers most reliably); retries on busy answers. */
async function overpass(query: string, label: string): Promise<OverpassResponse> {
  const url = `${CONFIG.endpoint}?data=${encodeURIComponent(query)}`;
  let lastError = 'no attempt made';
  for (let attempt = 1; attempt <= CONFIG.attempts; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': CONFIG.userAgent, accept: 'application/json' }, signal: AbortSignal.timeout((CONFIG.queryTimeoutSec + 30) * 1000) });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith('{')) {
        const body = JSON.parse(text) as OverpassResponse;
        if (Array.isArray(body.elements)) return body;
        lastError = 'response had no elements array';
      } else {
        const hint = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
        lastError = `HTTP ${res.status}: ${hint}`;
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    const wait = CONFIG.backoffMs * attempt;
    console.error(`[build-osm] ${label}: attempt ${attempt}/${CONFIG.attempts} failed (${lastError}); retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
  throw new Error(`${label}: Overpass did not answer after ${CONFIG.attempts} attempts (${lastError})`);
}

/** Every Nth vertex plus the first and last; never fewer than two for a real line. */
function simplify<T>(pts: readonly T[], every: number): T[] {
  if (pts.length <= 2) return [...pts];
  const out: T[] = [];
  for (let i = 0; i < pts.length; i++) if (i % every === 0 || i === pts.length - 1) out.push(pts[i]);
  return out;
}

/** The bbox grown by `metres` on every side. */
function grow(bbox: BBox, metres: number): BBox {
  const m = metresPerDegree((bbox.minLat + bbox.maxLat) / 2);
  return { minLat: bbox.minLat - metres / m.lat, maxLat: bbox.maxLat + metres / m.lat, minLng: bbox.minLng - metres / m.lng, maxLng: bbox.maxLng + metres / m.lng };
}

function toRoads(elements: OverpassElement[], bbox: BBox): OsmRoad[] {
  const roadBox = grow(bbox, CONFIG.roadBufferM);
  const roads: OsmRoad[] = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || !el.tags) continue;
    const cls = el.tags.highway as RoadClass | undefined;
    const name = el.tags.name?.trim();
    if (!cls || !(cls in PEDS_BY_ROAD_CLASS) || !name) continue;
    const kept = simplify(el.geometry, CONFIG.simplifyEvery).filter((g) => inBBox({ lat: g.lat, lng: g.lon }, roadBox));
    if (kept.length === 0) continue;
    roads.push({ id: el.id, name, class: cls, points: kept.map((g) => [round(g.lon), round(g.lat)] as [number, number]) });
  }
  return roads.sort((a, b) => a.id - b.id);
}

function pointOf(el: OverpassElement): { lat: number; lng: number } | null {
  if (typeof el.lat === 'number' && typeof el.lon === 'number') return { lat: el.lat, lng: el.lon };
  if (el.center) return { lat: el.center.lat, lng: el.center.lon };
  return null;
}

function poiKind(tags: Record<string, string>): OsmPoi['kind'] | null {
  if (tags.amenity === 'school') return 'school';
  if (tags.social_facility === 'nursing_home' || tags.social_facility === 'assisted_living') return 'senior';
  if (tags.highway === 'bus_stop' || tags.railway === 'station' || tags.railway === 'tram_stop' || tags.public_transport === 'platform') return 'transit';
  return null;
}

function toPlaces(elements: OverpassElement[], bbox: BBox): { pois: OsmPoi[]; addresses: OsmAddress[] } {
  const pois: OsmPoi[] = [];
  const addresses: (OsmAddress & { id: number })[] = [];
  for (const el of elements) {
    if (el.type === 'relation' || !el.tags) continue;
    const p = pointOf(el);
    if (!p || !inBBox(p, bbox)) continue;
    const kind = poiKind(el.tags);
    if (kind) pois.push({ id: el.id, kind, name: el.tags.name?.trim() || null, lat: round(p.lat), lng: round(p.lng) });
    const number = el.tags['addr:housenumber']?.trim();
    const street = el.tags['addr:street']?.trim();
    if (number && street) addresses.push({ id: el.id, number, street, lat: round(p.lat), lng: round(p.lng) });
  }
  pois.sort((a, b) => a.id - b.id);
  // One point per (street, number): a building outline and its entrance node often carry the same address.
  addresses.sort((a, b) => a.street.localeCompare(b.street) || a.number.localeCompare(b.number, 'en', { numeric: true }) || a.id - b.id);
  const seen = new Set<string>();
  const unique: OsmAddress[] = [];
  for (const a of addresses) {
    const key = `${a.street.toLowerCase()}|${a.number.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ number: a.number, street: a.street, lat: a.lat, lng: a.lng });
  }
  return { pois, addresses: unique };
}

/** One element per line so a refreshed extract diffs readably. */
function serialize(data: OsmData): string {
  const list = (rows: readonly unknown[]) => (rows.length === 0 ? '[]' : `[\n${rows.map((r) => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]`);
  const { roads, pois, addresses, ...head } = data;
  const headLines = Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{\n${headLines.join(',\n')},\n  "roads": ${list(roads)},\n  "pois": ${list(pois)},\n  "addresses": ${list(addresses)}\n}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outFile = resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : `assets/data/osm/${PILOT.slug}.json`);
  const bbox = PILOT_BBOX;
  console.error(`[build-osm] ${PILOT.name} bbox ${overpassBBox(bbox)} → ${outFile}`);

  const roadsRes = await overpass(roadsQuery(bbox), 'roads');
  await sleep(CONFIG.pauseBetweenQueriesMs);
  const placesRes = await overpass(placesQuery(bbox), 'places');

  const roads = toRoads(roadsRes.elements, bbox);
  const { pois, addresses } = toPlaces(placesRes.elements, bbox);
  const data: OsmData = {
    version: OSM_DATA_VERSION,
    fetchedAt: new Date().toISOString(),
    osmTimestamp: roadsRes.osm3s?.timestamp_osm_base ?? placesRes.osm3s?.timestamp_osm_base ?? null,
    bbox,
    roads,
    pois,
    addresses,
    attribution: OSM_ATTRIBUTION,
  };

  mkdirSync(dirname(outFile), { recursive: true });
  const text = serialize(data);
  writeFileSync(outFile, text);
  const byKind = pois.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.kind]: (acc[p.kind] ?? 0) + 1 }), {});
  console.error(`[build-osm] wrote ${(text.length / 1024).toFixed(0)} KB: roads ${roads.length} · addresses ${addresses.length} · schools ${byKind.school ?? 0} · senior ${byKind.senior ?? 0} · transit ${byKind.transit ?? 0} · OSM data ${data.osmTimestamp ?? 'n/a'}`);
}

main().catch((e) => {
  console.error(`[build-osm] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
