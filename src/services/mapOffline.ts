/**
 * Offline map pack (plan §9.6, §23.F; owner decision D2): one MapLibre offline region named 'pilot' covering the
 * pilot bbox at zoom 11–14, downloaded over Wi-Fi from S-12 with the measured size shown first, removable, and dated
 * because the tiles behind it roll weekly. @maplibre/maplibre-react-native v11 `OfflineManager.createPack` takes the
 * remote style URL (EXPO_PUBLIC_MAP_STYLE_URL); the map view itself renders the bundled snapshot, and the region's
 * tiles, glyphs and sprites serve both because they are keyed by URL. The ambient cache keeps recently viewed tiles
 * on its own; v11 exposes no way to read its size. Nothing here throws: every call returns the resulting state.
 * Web gets mapOffline.web.ts (no native module there). Provider details live here and in ui/HazardMap*.tsx only.
 */
import { OfflineManager, type OfflinePack, type OfflinePackError, type OfflinePackStatus } from '@maplibre/maplibre-react-native';

import { getState, isOfflineNow } from '@/store/appStore';

import { EMPTY_PACK_STATE, MAP_PACK, MAP_STYLE_URL, getMapPackState, isWifi, setMapPackState, type MapPackState } from './mapPackState';

export { EMPTY_PACK_STATE, MAP_PACK, MAP_STYLE_URL, getMapPackState, isWifi, resetMapPackState, subscribeMapPack, useMapPack, type MapPackError, type MapPackState, type MapPackStatus } from './mapPackState';

/** Native builds can hold a pack; the web stub says false. */
export const MAP_PACK_SUPPORTED = true;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isOurs(pack: OfflinePack): boolean {
  return pack.metadata?.name === MAP_PACK.name;
}

function onProgress(pack: OfflinePack, status: OfflinePackStatus) {
  if (!isOurs(pack)) return;
  const done = status.state === 'complete';
  setMapPackState({
    packId: pack.id,
    status: done ? 'ready' : 'downloading',
    percentage: done ? 100 : Math.round(Math.max(0, Math.min(100, status.percentage))),
    bytes: status.completedResourceSize,
    tiles: status.completedTileCount,
    completedAt: done ? new Date().toISOString() : null,
    error: null,
    errorDetail: null,
  });
}

function onError(pack: OfflinePack, error: OfflinePackError) {
  if (!isOurs(pack)) return;
  setMapPackState({ packId: pack.id, status: 'failed', error: 'native', errorDetail: error.message });
}

/** Unregister every region of ours MapLibre holds. Throws on native failure; callers turn that into state. */
async function deleteOurPacks(): Promise<void> {
  const packs = await OfflineManager.getPacks();
  for (const pack of packs) if (isOurs(pack)) await OfflineManager.deletePack(pack.id);
}

/**
 * Start the download. Refuses offline and, by default, off Wi-Fi (the pack is about 105 MB). A download while a pack
 * exists is a refresh: the old region goes first, so the dated tile path is re-read (plan §23.F).
 */
export async function downloadMapPack(opts: { wifiOnly?: boolean } = {}): Promise<MapPackState> {
  if (isOfflineNow()) return setMapPackState({ error: 'offline', errorDetail: null });
  if ((opts.wifiOnly ?? true) && !isWifi(getState().network.type)) return setMapPackState({ error: 'wifi', errorDetail: null });
  try {
    await deleteOurPacks();
    setMapPackState({ ...EMPTY_PACK_STATE, status: 'downloading', styleUrl: MAP_STYLE_URL });
    const pack = await OfflineManager.createPack(
      { mapStyle: MAP_STYLE_URL, bounds: MAP_PACK.bounds, minZoom: MAP_PACK.minZoom, maxZoom: MAP_PACK.maxZoom, metadata: { name: MAP_PACK.name, styleUrl: MAP_STYLE_URL, requestedAt: new Date().toISOString() } },
      onProgress,
      onError,
    );
    return setMapPackState({ packId: pack.id });
  } catch (e) {
    return setMapPackState({ status: 'failed', error: 'native', errorDetail: messageOf(e) });
  }
}

/** Remove the region and free its space. */
export async function removeMapPack(): Promise<MapPackState> {
  try {
    await deleteOurPacks();
    return setMapPackState({ ...EMPTY_PACK_STATE });
  } catch (e) {
    return setMapPackState({ error: 'native', errorDetail: messageOf(e) });
  }
}

/** Reconcile the persisted state with what MapLibre actually holds (S-12 open, app start after a kill mid-download). */
export async function refreshMapPackStatus(): Promise<MapPackState> {
  const current = getMapPackState();
  try {
    const pack = (await OfflineManager.getPacks()).find(isOurs) ?? null;
    if (!pack) return current.status === 'ready' || current.status === 'failed' ? setMapPackState({ ...EMPTY_PACK_STATE }) : current;
    const status = await pack.status();
    const progress = { packId: pack.id, bytes: status.completedResourceSize, tiles: status.completedTileCount };
    if (status.state === 'complete') return setMapPackState({ ...progress, status: 'ready', percentage: 100, completedAt: current.completedAt ?? new Date().toISOString(), error: null, errorDetail: null });
    if (status.state === 'active') return setMapPackState({ ...progress, status: 'downloading', percentage: Math.round(status.percentage) });
    // inactive: a download the app did not finish (killed, airplane mode). MapLibre does not resume it by itself.
    return setMapPackState({ ...progress, status: 'failed', percentage: Math.round(status.percentage), error: 'interrupted', errorDetail: null });
  } catch {
    return current;
  }
}
