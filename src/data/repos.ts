/**
 * Local-first repositories. Every read is synchronous and starts from local storage. Nothing here touches
 * the network. Keys are versioned (`name:v1`); reads are sanitised so a bad write never crashes the first frame.
 * Storage guard: when a write fails for lack of space, re-downloadable caches are dropped first and the user is
 * told exactly what was dropped. Drafts, prefs, session and the local links to own reports are never dropped.
 */
import { PublicReportSchema, type AlertItem, type AuthSession, type CacheMeta, type CacheMetaMap, type Draft, type DroppedItem, type Prefs, type PublicReport, type Settings, type StorageNotice } from '@/domain/types';

import { files } from './files';
import { kv } from './kv';

export const KEYS = {
  schema: 'meta:schemaVersion',
  onboarded: 'onboarded:v1',
  prefs: 'prefs:v1',
  settings: 'settings:v1',
  drafts: 'drafts:v1',
  mutations: 'mutations:v1',
  feed: 'feed:v1',
  alerts: 'alerts:v1',
  myReports: 'myReports:v1',
  votes: 'votes:v1',
  follows: 'follows:v1',
  session: 'session:v1',
  cacheMeta: 'cacheMeta:v1',
  storageNotice: 'storageNotice:v1',
} as const;

export const SCHEMA_VERSION = 1;

/** Call once at startup, synchronously, before any async storage access. */
export function initStorage(): void {
  const v = kv.get<number>(KEYS.schema);
  if (v !== SCHEMA_VERSION) kv.set(KEYS.schema, SCHEMA_VERSION);
}

// ---------- Storage guard: drop by priority, say what was dropped ----------

export const LOW_SPACE_BYTES = 5 * 1024 * 1024;

type NoticeListener = (n: StorageNotice) => void;
let noticeListener: NoticeListener | null = null;
export function onStorageNotice(l: NoticeListener | null): void {
  noticeListener = l;
}

export function isLowOnSpace(): boolean {
  const free = files.availableBytes();
  return Number.isFinite(free) && free < LOW_SPACE_BYTES;
}

/** Give up re-downloadable data first (feed, alerts), then photos of drafts that were already sent. */
export function dropLowPriority(): DroppedItem[] {
  const dropped: DroppedItem[] = [];
  if (kv.get<PublicReport[]>(KEYS.feed) != null) {
    kv.remove(KEYS.feed);
    kv.update<CacheMetaMap>(KEYS.cacheMeta, (prev) => {
      const next = { ...(prev ?? {}) };
      delete next.feed;
      return next;
    });
    dropped.push('feed-cache');
  }
  if (kv.get<AlertItem[]>(KEYS.alerts) != null) {
    kv.remove(KEYS.alerts);
    dropped.push('alerts-cache');
  }
  const drafts = kv.get<Draft[]>(KEYS.drafts) ?? [];
  const sentWithPhotos = drafts.filter((d) => d.status === 'sent' && d.photoUris.length > 0);
  if (sentWithPhotos.length > 0) {
    for (const d of sentWithPhotos) for (const uri of d.photoUris) files.remove(uri);
    kv.set(
      KEYS.drafts,
      drafts.map((d) => (d.status === 'sent' ? { ...d, photoUris: [] } : d)),
    );
    dropped.push('sent-draft-photos');
  }
  return dropped;
}

export function reportStorageNotice(dropped: DroppedItem[], recovered: boolean): StorageNotice | null {
  if (dropped.length === 0 && recovered) return null;
  const free = files.availableBytes();
  const notice: StorageNotice = { at: new Date().toISOString(), dropped, freeBytes: Number.isFinite(free) ? free : null, recovered };
  kv.set(KEYS.storageNotice, notice);
  noticeListener?.(notice);
  return notice;
}

function guardedSet<T>(key: string, value: T, shrink?: (v: T) => T): T {
  if (kv.set(key, value)) return value;
  const dropped = dropLowPriority();
  const retry = shrink ? shrink(value) : value;
  const ok = kv.set(key, retry);
  reportStorageNotice(dropped, ok);
  return retry;
}

function guardedUpdate<T>(key: string, fn: (prev: T | null) => T, shrink?: (v: T) => T): T {
  const next = kv.update<T>(key, fn);
  if (kv.lastWriteOk) return next;
  const dropped = dropLowPriority();
  const retried = kv.update<T>(key, (prev) => (shrink ? shrink(fn(prev)) : fn(prev)));
  reportStorageNotice(dropped, kv.lastWriteOk);
  return retried;
}

export const storageNoticeRepo = {
  get(): StorageNotice | null {
    return kv.get<StorageNotice>(KEYS.storageNotice);
  },
  clear(): void {
    kv.remove(KEYS.storageNotice);
  },
};

// ---------- Prefs / onboarding ----------

export const DEFAULT_PREFS: Prefs = {
  home: null,
  categories: ['vegetation', 'roadway', 'sidewalk', 'drainage', 'lighting'],
  quietHours: { start: '22:00', end: '07:00' }, // spec R14: quiet hours 10pm–7am except emergency
  updatedAt: '1970-01-01T00:00:00.000Z',
};

export function sanitizePrefs(p: unknown): Prefs {
  if (!p || typeof p !== 'object') return DEFAULT_PREFS;
  const o = p as Partial<Prefs>;
  const home = o.home && Number.isFinite(o.home.lat) && Number.isFinite(o.home.lng) ? { lat: o.home.lat, lng: o.home.lng, radiusM: Number.isFinite(o.home.radiusM) ? o.home.radiusM : 400 } : null;
  const categories = Array.isArray(o.categories) ? o.categories.filter((c): c is Prefs['categories'][number] => DEFAULT_PREFS.categories.includes(c as never)) : DEFAULT_PREFS.categories;
  const quietHours = o.quietHours && typeof o.quietHours.start === 'string' && typeof o.quietHours.end === 'string' ? o.quietHours : o.quietHours === null ? null : DEFAULT_PREFS.quietHours;
  return { home, categories: categories.length ? categories : DEFAULT_PREFS.categories, quietHours, updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : DEFAULT_PREFS.updatedAt };
}

export const prefsRepo = {
  get(): Prefs {
    return sanitizePrefs(kv.get(KEYS.prefs));
  },
  set(p: Prefs): Prefs {
    const clean = sanitizePrefs(p);
    guardedSet(KEYS.prefs, clean);
    return clean;
  },
  isOnboarded(): boolean {
    return kv.get<boolean>(KEYS.onboarded) === true;
  },
  setOnboarded(v: boolean): void {
    kv.set(KEYS.onboarded, v);
  },
};

// ---------- Settings (device-local switches, demo) ----------

export const DEFAULT_SETTINGS: Settings = { simulateOffline: false, demoScenario: null, demoClockOffsetMs: 0, visionAssist: process.env.EXPO_PUBLIC_VISION !== 'off' };

export function sanitizeSettings(s: unknown): Settings {
  if (!s || typeof s !== 'object') return DEFAULT_SETTINGS;
  const o = s as Partial<Settings>;
  const scenario = o.demoScenario === 'calm' || o.demoScenario === 'storm' || o.demoScenario === 'verify' ? o.demoScenario : null;
  return {
    simulateOffline: o.simulateOffline === true,
    demoScenario: scenario,
    demoClockOffsetMs: Number.isFinite(o.demoClockOffsetMs) ? (o.demoClockOffsetMs as number) : 0,
    visionAssist: typeof o.visionAssist === 'boolean' ? o.visionAssist : DEFAULT_SETTINGS.visionAssist,
  };
}

export const settingsRepo = {
  get(): Settings {
    return sanitizeSettings(kv.get(KEYS.settings));
  },
  patch(p: Partial<Settings>): Settings {
    return guardedUpdate<Settings>(KEYS.settings, (prev) => sanitizeSettings({ ...sanitizeSettings(prev), ...p }));
  },
};

// ---------- Drafts (offline-first intake, plan §9.2) ----------

export const DRAFT_RETENTION_MAX = 50;

export const draftsRepo = {
  getAll(): Draft[] {
    const list = kv.get<Draft[]>(KEYS.drafts);
    return Array.isArray(list) ? list.filter((d) => d && typeof d.id === 'string') : [];
  },
  upsert(draft: Draft): Draft[] {
    return guardedUpdate<Draft[]>(
      KEYS.drafts,
      (prev) => {
        const list = (prev ?? []).filter((d) => d.id !== draft.id);
        list.unshift(draft);
        return list.slice(0, DRAFT_RETENTION_MAX);
      },
      (list) => list.filter((d) => d.status !== 'sent'),
    );
  },
  remove(id: string): Draft[] {
    const victim = this.getAll().find((d) => d.id === id);
    if (victim) for (const uri of victim.photoUris) files.remove(uri);
    return guardedUpdate<Draft[]>(KEYS.drafts, (prev) => (prev ?? []).filter((d) => d.id !== id));
  },
  setStatus(id: string, status: Draft['status'], extra: Partial<Pick<Draft, 'failReason' | 'reportId'>> = {}): Draft[] {
    return guardedUpdate<Draft[]>(KEYS.drafts, (prev) => (prev ?? []).map((d) => (d.id === id ? { ...d, status, failReason: extra.failReason ?? (status === 'failed' ? d.failReason : null), reportId: extra.reportId ?? d.reportId, updatedAt: new Date().toISOString() } : d)));
  },
};

// ---------- Queued mutations (vote / comment / follow / verify while offline) ----------

export type QueuedMutation =
  | { id: string; kind: 'vote' | 'unvote' | 'follow' | 'unfollow'; reportId: string; at: string }
  | { id: string; kind: 'comment'; reportId: string; body: string; at: string }
  | { id: string; kind: 'verify'; reportId: string; verdict: 'confirmed' | 'rejected'; photoId?: string; note?: string; at: string };

export const mutationsRepo = {
  getAll(): QueuedMutation[] {
    const list = kv.get<QueuedMutation[]>(KEYS.mutations);
    return Array.isArray(list) ? list : [];
  },
  enqueue(m: QueuedMutation): QueuedMutation[] {
    return guardedUpdate<QueuedMutation[]>(KEYS.mutations, (prev) => [...(prev ?? []), m]);
  },
  remove(id: string): QueuedMutation[] {
    return guardedUpdate<QueuedMutation[]>(KEYS.mutations, (prev) => (prev ?? []).filter((m) => m.id !== id));
  },
};

// ---------- Cached feed and alerts (re-downloadable) ----------

export function sanitizeReports(list: unknown): PublicReport[] {
  if (!Array.isArray(list)) return [];
  const out: PublicReport[] = [];
  for (const item of list) {
    const r = PublicReportSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

export const feedRepo = {
  get(): PublicReport[] {
    return sanitizeReports(kv.get(KEYS.feed));
  },
  set(reports: PublicReport[]): number {
    const clean = sanitizeReports(reports);
    guardedSet(KEYS.feed, clean, (list) => list.slice(0, 100));
    return JSON.stringify(clean).length;
  },
  /** Merge one freshly fetched report into the cache (detail screens). */
  upsert(report: PublicReport): PublicReport[] {
    return guardedUpdate<PublicReport[]>(KEYS.feed, (prev) => {
      const list = sanitizeReports(prev).filter((r) => r.id !== report.id);
      list.unshift(report);
      return list;
    });
  },
};

export const alertsRepo = {
  getAll(): AlertItem[] {
    const list = kv.get<AlertItem[]>(KEYS.alerts);
    return Array.isArray(list) ? list : [];
  },
  set(items: AlertItem[]): void {
    guardedSet(KEYS.alerts, items.slice(0, 200));
  },
  markRead(id: string): AlertItem[] {
    return guardedUpdate<AlertItem[]>(KEYS.alerts, (prev) => (prev ?? []).map((a) => (a.id === id ? { ...a, read: true } : a)));
  },
};

// ---------- Local links to own reports (works for anonymous reports the server cannot link back) ----------

export interface MyReportLink {
  reportId: string;
  draftId: string | null;
  anonymous: boolean;
  createdAt: string;
}

export const myReportsRepo = {
  getAll(): MyReportLink[] {
    const list = kv.get<MyReportLink[]>(KEYS.myReports);
    return Array.isArray(list) ? list : [];
  },
  add(link: MyReportLink): MyReportLink[] {
    return guardedUpdate<MyReportLink[]>(KEYS.myReports, (prev) => [link, ...(prev ?? []).filter((l) => l.reportId !== link.reportId)]);
  },
};

// ---------- Own votes and follows (optimistic UI; reconciled with the server after each sync) ----------

function idSetRepo(key: string) {
  return {
    getAll(): string[] {
      const list = kv.get<string[]>(key);
      return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
    },
    set(id: string, on: boolean): string[] {
      return guardedUpdate<string[]>(key, (prev) => {
        const cur = new Set(Array.isArray(prev) ? prev : []);
        if (on) cur.add(id);
        else cur.delete(id);
        return [...cur];
      });
    },
    replaceAll(ids: string[]): string[] {
      return guardedUpdate<string[]>(key, () => [...new Set(ids)]);
    },
  };
}

export const votesRepo = idSetRepo(KEYS.votes);
export const followsRepo = idSetRepo(KEYS.follows);

// ---------- Session profile (the auth tokens themselves live in the auth client's storage) ----------

export const sessionRepo = {
  get(): AuthSession | null {
    const s = kv.get<AuthSession>(KEYS.session);
    return s && typeof s.userId === 'string' ? s : null;
  },
  set(s: AuthSession | null): void {
    if (s) kv.set(KEYS.session, s);
    else kv.remove(KEYS.session);
  },
};

// ---------- Cache metadata: every cached item carries when it was fetched ----------

export const cacheMetaRepo = {
  getAll(): CacheMetaMap {
    return kv.get<CacheMetaMap>(KEYS.cacheMeta) ?? {};
  },
  set(meta: CacheMeta): CacheMetaMap {
    return kv.update<CacheMetaMap>(KEYS.cacheMeta, (prev) => ({ ...(prev ?? {}), [meta.key]: meta }));
  },
};

/** Wipe everything (Offline data → Reset this phone). Drafts' photos are deleted too. */
export function resetAll(): void {
  for (const d of draftsRepo.getAll()) for (const uri of d.photoUris) files.remove(uri);
  for (const key of Object.values(KEYS)) kv.remove(key);
  initStorage();
}
