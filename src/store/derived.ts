/**
 * Derived state hooks: the visible report list (cache or labelled demo data), sorting, the open-hazard index,
 * own reports, pending drafts. Pure derivations over the store plus a slow clock tick so time-based values
 * advance without user interaction.
 */
import { useEffect, useMemo, useState } from 'react';

import { distanceM, type LatLng } from '@/domain/geo';
import { PILOT } from '@/domain/pilot';
import { nowMs, toEpoch } from '@/domain/time';
import type { Category, PublicReport } from '@/domain/types';

import { useAppState } from './appStore';

/** Re-renders every `ms` (default 30 s) and returns the app clock (device time + demo offset). */
export function useNow(ms = 30_000): number {
  const [tick, setTick] = useState(0);
  const offset = useAppState((s) => s.settings.demoClockOffsetMs);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  // Read the clock at render time so a demo offset change is reflected on the very next render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => nowMs(), [tick, offset]);
}

/** The real device clock, ticking every `ms`. For facts stamped in device time (GPS fixes, cache ages) that a demo clock must not distort. */
export function useRealNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Reports to show: the labelled demo set while a scenario is active, otherwise the cached feed. */
export function useReports(): PublicReport[] {
  const feed = useAppState((s) => s.feed);
  const demo = useAppState((s) => s.demoReports);
  const scenario = useAppState((s) => s.settings.demoScenario);
  return scenario ? demo : feed;
}

export function useReport(id: string | undefined): PublicReport | null {
  const reports = useReports();
  return useMemo(() => (id ? (reports.find((r) => r.id === id) ?? null) : null), [reports, id]);
}

export type FeedSort = 'urgency' | 'distance' | 'newest';

/** The point distances are measured from: GPS fix, else the home area, else the pilot centre. */
export function useVantage(): LatLng {
  const fix = useAppState((s) => s.location);
  const home = useAppState((s) => s.prefs.home);
  return useMemo(() => (fix ? { lat: fix.lat, lng: fix.lng } : home ? { lat: home.lat, lng: home.lng } : PILOT.center), [fix, home]);
}

export function sortReports(reports: PublicReport[], sort: FeedSort, from: LatLng): PublicReport[] {
  const list = reports.slice();
  if (sort === 'urgency') list.sort((a, b) => b.score - a.score);
  if (sort === 'newest') list.sort((a, b) => toEpoch(b.createdAt) - toEpoch(a.createdAt));
  if (sort === 'distance') list.sort((a, b) => distanceM(from, a) - distanceM(from, b));
  return list;
}

export function useFeed(sort: FeedSort, filter: Category | 'all'): PublicReport[] {
  const reports = useReports();
  const from = useVantage();
  return useMemo(() => sortReports(filter === 'all' ? reports : reports.filter((r) => r.category === filter), sort, from), [reports, sort, filter, from]);
}

const OPEN = new Set(['new', 'triaged', 'assessed', 'mitigated', 'scheduled']);

export interface HazardIndex {
  /** 0–100: mean score of open reports within the radius; 0 when there are none. Not a prediction. */
  value: number;
  count: number;
  /** The three highest-scoring open reports, named so the index explains itself (spec R1 note). */
  drivers: PublicReport[];
}

/** "What has been reported near you, weighted by score." Plain aggregate, labelled as such on screen. */
export function hazardIndex(reports: PublicReport[], center: LatLng, radiusM: number): HazardIndex {
  const open = reports.filter((r) => OPEN.has(r.status) && distanceM(center, r) <= radiusM).sort((a, b) => b.score - a.score);
  if (open.length === 0) return { value: 0, count: 0, drivers: [] };
  const mean = open.reduce((s, r) => s + r.score, 0) / open.length;
  return { value: Math.round(mean), count: open.length, drivers: open.slice(0, 3) };
}

export function useHazardIndex(radiusM = 800): HazardIndex {
  const reports = useReports();
  const from = useVantage();
  return useMemo(() => hazardIndex(reports, from, radiusM), [reports, from, radiusM]);
}

/** Own reports: server-linked ones plus the local links kept for anonymous reports. */
export function useMyReports(): PublicReport[] {
  const links = useAppState((s) => s.myReports);
  const reports = useReports();
  return useMemo(() => {
    const ids = new Set(links.map((l) => l.reportId));
    return reports.filter((r) => ids.has(r.id));
  }, [links, reports]);
}

export function usePendingDrafts() {
  const drafts = useAppState((s) => s.drafts);
  return useMemo(() => drafts.filter((d) => d.status !== 'sent'), [drafts]);
}
