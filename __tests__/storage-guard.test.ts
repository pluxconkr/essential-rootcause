/**
 * Low storage: when a write fails because the phone is full, the app gives up re-downloadable data by
 * priority (cached feed → cached alerts → photos of drafts already sent), retries, and says what it dropped.
 * Prefs, pending drafts, own-report links and the session are never dropped.
 */
import { SQLiteStorage } from 'expo-sqlite/kv-store';

import { kv } from '@/data/kv';
import { KEYS, alertsRepo, draftsRepo, feedRepo, myReportsRepo, onStorageNotice, prefsRepo, storageNoticeRepo, DEFAULT_PREFS } from '@/data/repos';
import { buildDemoReports } from '@/domain/demo';
import { PILOT } from '@/domain/pilot';
import type { Draft, StorageNotice } from '@/domain/types';

const draft = (id: string, status: Draft['status'], photos: string[]): Draft => ({ id, photoUris: photos, gps: null, locationConfirmed: true, capturedAt: '2026-10-05T12:00:00.000Z', form: {}, status, failReason: null, reportId: null, updatedAt: '2026-10-05T12:00:00.000Z' });

function failWrites(key: string, times: number) {
  const orig = SQLiteStorage.prototype.setItemSync;
  let left = times;
  return jest.spyOn(SQLiteStorage.prototype, 'setItemSync').mockImplementation(function (this: SQLiteStorage, k: string, v: Parameters<SQLiteStorage['setItemSync']>[1]) {
    if (k === key && left > 0) {
      left -= 1;
      throw new Error('database or disk is full');
    }
    return orig.call(this, k, v);
  });
}

describe('storage guard', () => {
  let notices: StorageNotice[];

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    kv.clear();
    notices = [];
    onStorageNotice((n) => notices.push(n));
    feedRepo.set(buildDemoReports('calm', PILOT.center));
    alertsRepo.set([{ id: 'a1', kind: 'status', title: 'WO moved to Scheduled', body: 'Crew window 14–18 Sep', reportId: null, alertId: null, at: '2026-10-05T12:00:00.000Z', read: false }]);
    draftsRepo.upsert(draft('d_sent', 'sent', ['file:///sent-photo.jpg']));
    draftsRepo.upsert(draft('d_queued', 'queued', ['file:///queued-photo.jpg']));
    myReportsRepo.add({ reportId: 'r1', draftId: 'd_sent', anonymous: true, createdAt: '2026-10-05T12:00:00.000Z' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    onStorageNotice(null);
  });

  test('a failed prefs write drops the feed cache first, retries, and records what was dropped', () => {
    const spy = failWrites(KEYS.prefs, 1);
    const saved = prefsRepo.set({ ...DEFAULT_PREFS, home: { lat: 40.5, lng: -74.45, radiusM: 400 } });
    expect(saved.home?.radiusM).toBe(400);
    expect(prefsRepo.get().home?.lat).toBe(40.5);
    expect(feedRepo.get()).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0].dropped).toContain('feed-cache');
    expect(notices[0].recovered).toBe(true);
    expect(storageNoticeRepo.get()?.dropped).toContain('feed-cache');
    spy.mockRestore();
  });

  test('pending drafts, own-report links and the sent draft record survive; only sent photos are released', () => {
    const spy = failWrites(KEYS.prefs, 1);
    prefsRepo.set(DEFAULT_PREFS);
    const drafts = draftsRepo.getAll();
    expect(drafts.find((d) => d.id === 'd_queued')?.photoUris).toEqual(['file:///queued-photo.jpg']);
    expect(drafts.find((d) => d.id === 'd_sent')?.photoUris).toEqual([]);
    expect(myReportsRepo.getAll().map((l) => l.reportId)).toEqual(['r1']);
    expect(notices[0].dropped).toEqual(expect.arrayContaining(['feed-cache', 'alerts-cache', 'sent-draft-photos']));
    spy.mockRestore();
  });

  test('when the retry also fails the notice says so and nothing crashes', () => {
    const spy = failWrites(KEYS.prefs, 5);
    expect(() => prefsRepo.set(DEFAULT_PREFS)).not.toThrow();
    expect(notices).toHaveLength(1);
    expect(notices[0].recovered).toBe(false);
    spy.mockRestore();
  });
});
