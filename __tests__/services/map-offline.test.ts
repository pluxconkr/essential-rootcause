/**
 * Offline map pack state machine (plan §9.6, §23.F) against the maplibre-react-native mock's OfflineManager:
 * refuses offline and off Wi-Fi, downloads the pilot bbox at zoom 11–14 from the remote style URL, follows progress
 * to ready with a pack date, persists under kv 'mapPack:v1', fails on native errors, removes, and reconciles with
 * what MapLibre actually holds. Never throws.
 */
import { OfflineManager } from '@maplibre/maplibre-react-native';

import type { MockOfflineManager } from '../../__mocks__/@maplibre/maplibre-react-native';
import { kv } from '@/data/kv';
import { PILOT_BBOX } from '@/domain/pilot';
import { MAP_PACK, MAP_STYLE_URL, downloadMapPack, getMapPackState, isWifi, refreshMapPackStatus, removeMapPack, resetMapPackState, subscribeMapPack } from '@/services/mapOffline';
import { setMapPackState } from '@/services/mapPackState';
import { actions, hydrate, setState } from '@/store/appStore';

const manager = OfflineManager as unknown as MockOfflineManager;

function online(type: 'WIFI' | 'CELLULAR') {
  actions.patchSettings({ simulateOffline: false });
  setState({ network: { online: true, type } });
}

beforeEach(() => {
  hydrate();
  manager.__reset();
  resetMapPackState();
  online('WIFI');
});

describe('pack definition', () => {
  test('covers the pilot bbox at zoom 11–14 and names the remote style', () => {
    expect(MAP_PACK.bounds).toEqual([PILOT_BBOX.minLng, PILOT_BBOX.minLat, PILOT_BBOX.maxLng, PILOT_BBOX.maxLat]);
    expect(MAP_PACK.minZoom).toBe(11);
    expect(MAP_PACK.maxZoom).toBe(14);
    expect(MAP_PACK.key).toBe('mapPack:v1');
    expect(MAP_STYLE_URL).toMatch(/^https:\/\//);
    expect(MAP_PACK.estimateMB).toBeGreaterThan(0);
    expect(isWifi('WIFI')).toBe(true);
    expect(isWifi('CELLULAR')).toBe(false);
    expect(isWifi(null)).toBe(false);
  });
});

describe('download', () => {
  test('refuses while offline and off Wi-Fi without touching MapLibre', async () => {
    actions.patchSettings({ simulateOffline: true });
    expect(await downloadMapPack()).toMatchObject({ status: 'none', error: 'offline' });
    online('CELLULAR');
    expect(await downloadMapPack()).toMatchObject({ status: 'none', error: 'wifi' });
    expect(manager.createOptions).toHaveLength(0);
    // Explicitly allowed over cellular → proceeds.
    expect(await downloadMapPack({ wifiOnly: false })).toMatchObject({ status: 'downloading', error: null });
  });

  test('creates the pack with the style URL, bounds and zooms, follows progress to ready and persists the state', async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeMapPack(() => seen.push(getMapPackState().status));
    const started = await downloadMapPack();
    expect(started).toMatchObject({ status: 'downloading', percentage: 0, styleUrl: MAP_STYLE_URL, error: null });
    expect(started.packId).toMatch(/^mock-pack-/);
    expect(manager.createOptions[0]).toMatchObject({ mapStyle: MAP_STYLE_URL, bounds: MAP_PACK.bounds, minZoom: 11, maxZoom: 14, metadata: { name: 'pilot', styleUrl: MAP_STYLE_URL } });

    manager.__emitProgress(started.packId!, { state: 'active', percentage: 42.4, completedResourceSize: 44_000_000, completedTileCount: 17 });
    expect(getMapPackState()).toMatchObject({ status: 'downloading', percentage: 42, bytes: 44_000_000, tiles: 17, completedAt: null });

    manager.__emitProgress(started.packId!, { state: 'complete', percentage: 100, completedResourceSize: 104_900_000, completedTileCount: 39 });
    const ready = getMapPackState();
    expect(ready).toMatchObject({ status: 'ready', percentage: 100, bytes: 104_900_000, tiles: 39, error: null });
    expect(typeof ready.completedAt).toBe('string');
    expect(kv.get(MAP_PACK.key)).toMatchObject({ status: 'ready', packId: started.packId });
    expect(seen).toEqual(expect.arrayContaining(['downloading', 'ready']));
    unsubscribe();
  });

  test('a native error leaves a failed state with the message; a native throw at creation does too', async () => {
    const started = await downloadMapPack();
    manager.__emitError(started.packId!, { id: started.packId!, message: 'HTTP 503 from tiles.openfreemap.org' });
    expect(getMapPackState()).toMatchObject({ status: 'failed', error: 'native', errorDetail: 'HTTP 503 from tiles.openfreemap.org' });

    const original = manager.createPack;
    manager.createPack = async () => {
      throw new Error('database locked');
    };
    expect(await downloadMapPack()).toMatchObject({ status: 'failed', error: 'native', errorDetail: 'database locked' });
    manager.createPack = original;
  });

  test('downloading again replaces the previous region (the dated tile path rolls weekly)', async () => {
    const first = await downloadMapPack();
    manager.__emitProgress(first.packId!, { state: 'complete', percentage: 100 });
    const second = await downloadMapPack();
    expect(second.packId).not.toBe(first.packId);
    const packs = await manager.getPacks();
    expect(packs.map((p) => p.id)).toEqual([second.packId]);
  });
});

describe('remove and reconcile', () => {
  test('remove deletes the region and returns to the empty state', async () => {
    const started = await downloadMapPack();
    manager.__emitProgress(started.packId!, { state: 'complete', percentage: 100, completedResourceSize: 1 });
    expect(await removeMapPack()).toMatchObject({ status: 'none', packId: null, bytes: 0, completedAt: null });
    expect(await manager.getPacks()).toHaveLength(0);
    expect(kv.get(MAP_PACK.key)).toMatchObject({ status: 'none' });
  });

  test('refresh: a persisted "ready" with no native pack resets; a complete native pack becomes ready; an inactive one is "interrupted"', async () => {
    setMapPackState({ status: 'ready', packId: 'gone', percentage: 100, bytes: 5 });
    expect(await refreshMapPackStatus()).toMatchObject({ status: 'none', packId: null });

    const started = await downloadMapPack();
    manager.__emitProgress(started.packId!, { state: 'complete', percentage: 100, completedResourceSize: 7, completedTileCount: 39 });
    resetMapPackState(); // e.g. the app was reinstalled over a kept database
    expect(await refreshMapPackStatus()).toMatchObject({ status: 'ready', packId: started.packId, bytes: 7, tiles: 39, percentage: 100 });

    manager.__emitProgress(started.packId!, { state: 'inactive', percentage: 60 });
    expect(await refreshMapPackStatus()).toMatchObject({ status: 'failed', error: 'interrupted', percentage: 60 });
  });

  test('a corrupt persisted value is sanitised, never thrown', () => {
    kv.set(MAP_PACK.key, { status: 'bogus', percentage: 'many', bytes: -3, error: 'nope' });
    resetMapPackState();
    kv.set(MAP_PACK.key, { status: 'bogus', percentage: 'many', bytes: -3, error: 'nope' });
    expect(getMapPackState()).toMatchObject({ status: 'none', percentage: 0, bytes: 0, error: null });
  });
});
