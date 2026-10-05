/**
 * Cache-first refresh orchestration. Never throws, never blocks rendering, never runs offline, never runs
 * while a demo scenario is active (demo data is labelled and must not be mixed with live reports).
 * The UI is already drawn from local data (cached feed, drafts, own reports) before any of this starts.
 */
import { cacheMetaRepo } from '@/data/repos';
import { bboxAround } from '@/domain/geo';
import { PILOT, PILOT_BBOX } from '@/domain/pilot';
import type { AssetKey } from '@/domain/types';
import { actions, getState, isOfflineNow } from '@/store/appStore';

import { reportsApi } from './apiClient';
import { flush } from './syncQueue';

export interface RefreshResult {
  feed: 'ok' | 'skipped' | 'failed';
  /** Drafts uploaded this run. */
  synced: number;
}

function stamp(key: AssetKey, bytes: number, version: string) {
  // Device time on purpose: a demo scenario shifts the app clock, but a download happened when it happened.
  const meta = cacheMetaRepo.set({ key, fetchedAt: new Date().toISOString(), source: 'network', bytes, version });
  actions.setCacheMeta(meta);
}

/** The bbox the feed is fetched for: the home area with a margin, else the whole pilot. */
export function feedBBoxParam(): string {
  const home = getState().prefs.home;
  const b = home ? bboxAround({ lat: home.lat, lng: home.lng }, Math.max(home.radiusM * 4, 1500)) : PILOT_BBOX;
  return [b.minLng, b.minLat, b.maxLng, b.maxLat].map((n) => n.toFixed(5)).join(',');
}

export async function refreshFeed(): Promise<RefreshResult['feed']> {
  if (isOfflineNow() || getState().settings.demoScenario) return 'skipped';
  const res = await reportsApi.list({ bbox: feedBBoxParam(), sort: 'score', limit: 100 });
  if (!res.ok) return 'failed';
  actions.setFeed(res.data.reports);
  stamp('feed', JSON.stringify(res.data.reports).length, PILOT.slug);
  return 'ok';
}

let inFlight: Promise<RefreshResult> | null = null;

/** Refresh everything that can be refreshed. Concurrent calls share one run. */
export function refreshAll(): Promise<RefreshResult> {
  if (inFlight) return inFlight;
  actions.setRefreshing(true);
  inFlight = (async () => {
    const total = 2;
    actions.setRefreshProgress(0, total);
    const synced = (await flush()).sent;
    actions.setRefreshProgress(1, total);
    const feed = await refreshFeed();
    actions.setRefreshProgress(2, total);
    actions.setRefreshing(false, Date.now());
    return { feed, synced };
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Foreground policy: refresh if the last attempt is older than `minAgeMs`. */
export function refreshIfStale(minAgeMs = 5 * 60_000): Promise<RefreshResult | null> {
  const last = getState().lastRefreshAt;
  if (last && Date.now() - last < minAgeMs) return Promise.resolve(null);
  return refreshAll();
}
