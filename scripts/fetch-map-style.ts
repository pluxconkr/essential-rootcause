/**
 * Snapshot the remote MapLibre style into assets/map/style.json (plan §23.F "Bundled style"). The app passes this
 * object to the map (`mapStyle` on native, `style` on web), so the style always loads locally and the report pins
 * render even when every tile request fails; EXPO_PUBLIC_MAP_STYLE_URL only selects which remote style is
 * snapshotted here and downloaded by the offline pack.
 *
 *   node scripts/fetch-map-style.ts          (Node ≥ 22.18 strips the types itself; `npx tsx` works too)
 *
 * Relative sprite / glyph / source URLs are resolved against the style URL so the bundled copy needs no base URL.
 * `metadata._fetchedAt` records when the snapshot was taken and `metadata._source` where from. When the fetch
 * fails and a snapshot already exists it is kept; when none exists a minimal valid style (version 8, the
 * OpenFreeMap vector source, glyphs, a few base layers) is written and the script says so. Self-contained: node
 * built-ins only, erasable TypeScript syntax only.
 */
/// <reference types="node" />
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'; // plan: Appendix C EXPO_PUBLIC_MAP_STYLE_URL default
const OPENFREEMAP = {
  tileJson: 'https://tiles.openfreemap.org/planet', // the liberty style's vector source (TileJSON; its `tiles` path is dated and rolls weekly)
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
} as const;
const OUT_FILE = path.resolve(import.meta.dirname, '../assets/map/style.json');
const FETCH_TIMEOUT_MS = 20_000;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Absolute URLs (any scheme) pass through untouched; relative ones resolve against `base`. MapLibre's `{z}` / `{fontstack}` placeholders survive the URL parser. */
export function resolveUrl(value: string, base: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return new URL(value, base).toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}');
}

/** Resolve every relative sprite, glyph, source `url` and source `tiles` entry of a style against `base`. Returns a new object. */
export function absolutizeStyle(style: Json, base: string): Json {
  const out: Json = { ...style };
  if (typeof out.sprite === 'string') out.sprite = resolveUrl(out.sprite, base);
  else if (Array.isArray(out.sprite)) out.sprite = out.sprite.map((s) => (isObject(s) && typeof s.url === 'string' ? { ...s, url: resolveUrl(s.url, base) } : s));
  if (typeof out.glyphs === 'string') out.glyphs = resolveUrl(out.glyphs, base);
  if (isObject(out.sources)) {
    const sources: Json = {};
    for (const [id, src] of Object.entries(out.sources)) {
      if (!isObject(src)) {
        sources[id] = src;
        continue;
      }
      const next: Json = { ...src };
      if (typeof next.url === 'string') next.url = resolveUrl(next.url, base);
      if (Array.isArray(next.tiles)) next.tiles = next.tiles.map((t) => (typeof t === 'string' ? resolveUrl(t, base) : t));
      sources[id] = next;
    }
    out.sources = sources;
  }
  return out;
}

function withMetadata(style: Json, meta: Json): Json {
  return { ...style, metadata: { ...(isObject(style.metadata) ? style.metadata : {}), ...meta } };
}

/** Minimal valid style for a build made while the provider is unreachable: enough base layers to read the city. */
export function fallbackStyle(fetchedAt: string, source: string, reason: string): Json {
  return {
    version: 8,
    name: 'RootCause fallback (remote style unavailable at build time)',
    metadata: { _fetchedAt: fetchedAt, _source: source, _fallback: reason },
    sources: { openmaptiles: { type: 'vector', url: OPENFREEMAP.tileJson } },
    glyphs: OPENFREEMAP.glyphs,
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#f2efe9' } },
      { id: 'park', type: 'fill', source: 'openmaptiles', 'source-layer': 'park', paint: { 'fill-color': '#d8e8c8', 'fill-opacity': 0.7 } },
      { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', paint: { 'fill-color': '#a0c8f0' } },
      { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': '#e0dcd4', 'fill-outline-color': '#d0cbc2' } },
      { id: 'road', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 16, 6] } },
      {
        id: 'road-label',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'transportation_name',
        minzoom: 13,
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11 },
        paint: { 'text-color': '#4a4a4a', 'text-halo-color': '#ffffff', 'text-halo-width': 1 },
      },
    ],
  };
}

async function fetchStyle(url: string): Promise<Json> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: 'application/json', 'User-Agent': 'RootCause-build/1.0 (scripts/fetch-map-style.ts)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json: unknown = await res.json();
  if (!isObject(json) || json.version !== 8 || !Array.isArray(json.layers) || !isObject(json.sources)) throw new Error('not a MapLibre style (version 8 with sources and layers)');
  return json;
}

async function existingSnapshot(): Promise<Json | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(OUT_FILE, 'utf8'));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function write(style: Json): Promise<number> {
  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  const text = `${JSON.stringify(style, null, 2)}\n`;
  await writeFile(OUT_FILE, text, 'utf8');
  return Buffer.byteLength(text);
}

async function main(): Promise<void> {
  const styleUrl = (process.env.EXPO_PUBLIC_MAP_STYLE_URL ?? '').trim() || DEFAULT_STYLE_URL;
  const fetchedAt = new Date().toISOString();
  const rel = path.relative(process.cwd(), OUT_FILE);
  console.log(`fetch-map-style: ${styleUrl}`);
  try {
    const style = withMetadata(absolutizeStyle(await fetchStyle(styleUrl), styleUrl), { _fetchedAt: fetchedAt, _source: styleUrl });
    const bytes = await write(style);
    const sources = Object.keys(style.sources as Json);
    console.log(`wrote ${rel} (${(bytes / 1024).toFixed(0)} KB): ${(style.layers as unknown[]).length} layers, sources ${sources.join(', ')}, sprite ${String(style.sprite)}, glyphs ${String(style.glyphs)}`);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const kept = await existingSnapshot();
    if (kept) {
      const meta = isObject(kept.metadata) ? kept.metadata : {};
      console.warn(`fetch failed (${reason}); kept the existing snapshot ${rel} from ${String(meta._fetchedAt ?? 'an unknown date')}`);
      return;
    }
    const bytes = await write(fallbackStyle(fetchedAt, styleUrl, reason));
    console.warn(`fetch failed (${reason}) and no snapshot existed: wrote the MINIMAL FALLBACK style to ${rel} (${(bytes / 1024).toFixed(0)} KB). Re-run with network access before a release build.`);
  }
}

await main();
