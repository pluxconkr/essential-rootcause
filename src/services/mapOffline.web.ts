/**
 * Web stand-in for the offline map pack service: the browser has no MapLibre Native offline database, and the native
 * module must never be imported on web. Same exports as mapOffline.ts; every action reports 'unsupported'.
 */
import { EMPTY_PACK_STATE, getMapPackState, setMapPackState, type MapPackState } from './mapPackState';

export { EMPTY_PACK_STATE, MAP_PACK, MAP_STYLE_URL, getMapPackState, isWifi, resetMapPackState, subscribeMapPack, useMapPack, type MapPackError, type MapPackState, type MapPackStatus } from './mapPackState';

export const MAP_PACK_SUPPORTED = false;

export async function downloadMapPack(_opts: { wifiOnly?: boolean } = {}): Promise<MapPackState> {
  return setMapPackState({ error: 'unsupported', errorDetail: null });
}

export async function removeMapPack(): Promise<MapPackState> {
  return setMapPackState({ ...EMPTY_PACK_STATE });
}

export async function refreshMapPackStatus(): Promise<MapPackState> {
  return getMapPackState();
}
