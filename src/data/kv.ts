/**
 * Synchronous key-value store backed by SQLite (expo-sqlite/kv-store).
 * Values are JSON. Reads are synchronous so the first frame renders from disk.
 *
 * Web gets `kv.web.ts` (localStorage) — expo-sqlite is never bundled for web.
 */
import { SQLiteStorage } from 'expo-sqlite/kv-store';

const store = new SQLiteStorage('rootcause');

export const kv = {
  get<T>(key: string): T | null {
    try {
      const raw = store.getItemSync(key);
      if (raw == null) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },
  /** false when the write did not reach disk (e.g. the phone is out of space). */
  lastWriteOk: true,
  set(key: string, value: unknown): boolean {
    try {
      store.setItemSync(key, JSON.stringify(value));
      this.lastWriteOk = true;
      return true;
    } catch (e) {
      if (__DEV__) console.warn('[kv] set failed', key, e);
      this.lastWriteOk = false;
      return false;
    }
  },
  /** Atomic read-modify-write inside one SQLite transaction. */
  update<T>(key: string, fn: (prev: T | null) => T): T {
    let next: T | null = null;
    try {
      store.setItemSync(key, (prev) => {
        let parsed: T | null = null;
        try {
          parsed = prev == null ? null : (JSON.parse(prev) as T);
        } catch {
          parsed = null;
        }
        next = fn(parsed);
        return JSON.stringify(next);
      });
      this.lastWriteOk = true;
    } catch (e) {
      if (__DEV__) console.warn('[kv] update failed', key, e);
      this.lastWriteOk = false;
      next = fn(this.get<T>(key));
    }
    return next as T;
  },
  remove(key: string): void {
    try {
      store.removeItemSync(key);
    } catch {
      /* ignore */
    }
  },
  keys(): string[] {
    try {
      return store.getAllKeysSync();
    } catch {
      return [];
    }
  },
  clear(): void {
    try {
      store.clearSync();
    } catch {
      /* ignore */
    }
  },
};

export type KV = typeof kv;
