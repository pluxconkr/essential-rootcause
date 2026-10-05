/**
 * Offline map pack state shared by the native service (mapOffline.ts), its web stub (mapOffline.web.ts) and the
 * S-12 cell (ui/MapPackCell): the pack definition — the pilot bbox at zoom 11–14 and the remote style it downloads
 * (plan §9.6, §23.F) — the state persisted under kv 'mapPack:v1', and a tiny subscription so the cell re-renders as
 * a download progresses. Nothing here touches MapLibre or the network.
 */
import { useSyncExternalStore } from 'react';

import { kv } from '@/data/kv';
import { PILOT, PILOT_BBOX } from '@/domain/pilot';

/** The remote style the snapshot script and the offline pack use; the map itself renders the bundled snapshot (plan §23.F). */
export const MAP_STYLE_URL = (process.env.EXPO_PUBLIC_MAP_STYLE_URL ?? '').trim() || 'https://tiles.openfreemap.org/styles/liberty';

export interface MapPackDefinition {
  readonly key: string;
  readonly name: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  /** [west, south, east, north] — the order MapLibre's offline API takes. */
  readonly bounds: [number, number, number, number];
  /** Shown before the download (plan §9.6 "measured size shown before download"). */
  readonly estimateMB: number;
  readonly areaLabel: string;
}

export const MAP_PACK: MapPackDefinition = {
  key: 'mapPack:v1',
  name: 'pilot',
  minZoom: 11, // plan §23.F
  maxZoom: 14, // plan §23.F: OpenFreeMap's planet TileJSON ends at 14; zoom 15+ overzooms the zoom-14 data
  bounds: [PILOT_BBOX.minLng, PILOT_BBOX.minLat, PILOT_BBOX.maxLng, PILOT_BBOX.maxLat],
  // Measured 2026-10-06 (docs/data-sources.md §7): 39 tiles ≈ 2.2 MB + sprites 0.2 MB + glyphs ≈ 103 MB, because MapLibre
  // Native fetches all 256 glyph ranges of each of the liberty style's three font stacks for an offline region.
  estimateMB: 105,
  areaLabel: `${PILOT.name} · zoom 11–14`,
};

export type MapPackStatus = 'none' | 'downloading' | 'ready' | 'failed';
export type MapPackError = 'offline' | 'wifi' | 'unsupported' | 'interrupted' | 'native';

export interface MapPackState {
  status: MapPackStatus;
  /** MapLibre's id for the region, once created. */
  packId: string | null;
  /** 0–100 while downloading; 100 when ready. */
  percentage: number;
  /** Bytes MapLibre reports as downloaded so far (the real size once ready). */
  bytes: number;
  tiles: number;
  /** Device time when the download finished — the pack date shown on S-12; the tiles behind it roll weekly (plan §23.F). */
  completedAt: string | null;
  styleUrl: string | null;
  /** Why the last action did not complete; null when it did. */
  error: MapPackError | null;
  errorDetail: string | null;
  updatedAt: string;
}

export const EMPTY_PACK_STATE: MapPackState = { status: 'none', packId: null, percentage: 0, bytes: 0, tiles: 0, completedAt: null, styleUrl: null, error: null, errorDetail: null, updatedAt: '1970-01-01T00:00:00.000Z' };

const STATUSES: readonly MapPackStatus[] = ['none', 'downloading', 'ready', 'failed'];
const ERRORS: readonly MapPackError[] = ['offline', 'wifi', 'unsupported', 'interrupted', 'native'];

/** A bad write never crashes the cell: every field falls back to the empty state. */
export function sanitizePackState(s: unknown): MapPackState {
  if (!s || typeof s !== 'object') return EMPTY_PACK_STATE;
  const o = s as Partial<MapPackState>;
  const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    status: STATUSES.includes(o.status as MapPackStatus) ? (o.status as MapPackStatus) : 'none',
    packId: str(o.packId),
    percentage: Math.round(num(o.percentage, 0, 100)),
    bytes: num(o.bytes, 0, Number.MAX_SAFE_INTEGER),
    tiles: num(o.tiles, 0, Number.MAX_SAFE_INTEGER),
    completedAt: str(o.completedAt),
    styleUrl: str(o.styleUrl),
    error: ERRORS.includes(o.error as MapPackError) ? (o.error as MapPackError) : null,
    errorDetail: str(o.errorDetail),
    updatedAt: str(o.updatedAt) ?? EMPTY_PACK_STATE.updatedAt,
  };
}

let snapshot: MapPackState | null = null;
const listeners = new Set<() => void>();

/** Synchronous; the first call reads kv, later calls return the same object until something changes (useSyncExternalStore needs that). */
export function getMapPackState(): MapPackState {
  if (!snapshot) snapshot = sanitizePackState(kv.get(MAP_PACK.key));
  return snapshot;
}

export function setMapPackState(patch: Partial<MapPackState>): MapPackState {
  const next: MapPackState = { ...getMapPackState(), ...patch, updatedAt: new Date().toISOString() };
  kv.set(MAP_PACK.key, next); // a failed write (phone full) leaves the in-memory state serving this session
  snapshot = next;
  for (const l of listeners) l();
  return next;
}

export function resetMapPackState(): void {
  kv.remove(MAP_PACK.key);
  snapshot = null;
  for (const l of listeners) l();
}

export function subscribeMapPack(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useMapPack(): MapPackState {
  return useSyncExternalStore(subscribeMapPack, getMapPackState, getMapPackState);
}

/** expo-network's NetworkStateType values that are not metered: the pack downloads only on these (plan §9.6 "over Wi-Fi"). */
export function isWifi(networkType: string | null): boolean {
  return networkType === 'WIFI' || networkType === 'ETHERNET';
}
