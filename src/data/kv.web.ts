/**
 * Web fallback for the key-value store: localStorage with an in-memory mirror.
 * Web is a "must not crash" target, not the product target.
 */
const mem = new Map<string, string>();

function ls(): Storage | null {
  try {
    return typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

const PREFIX = 'rootcause:';

export const kv = {
  get<T>(key: string): T | null {
    try {
      const raw = ls()?.getItem(PREFIX + key) ?? mem.get(key) ?? null;
      return raw == null ? null : (JSON.parse(raw) as T);
    } catch {
      return null;
    }
  },
  lastWriteOk: true,
  set(key: string, value: unknown): boolean {
    const raw = JSON.stringify(value);
    mem.set(key, raw);
    try {
      ls()?.setItem(PREFIX + key, raw);
      this.lastWriteOk = true;
    } catch {
      /* quota / private mode — the in-memory copy still serves this session */
      this.lastWriteOk = false;
    }
    return this.lastWriteOk;
  },
  update<T>(key: string, fn: (prev: T | null) => T): T {
    const next = fn(this.get<T>(key));
    this.set(key, next);
    return next;
  },
  remove(key: string): void {
    mem.delete(key);
    try {
      ls()?.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
  },
  keys(): string[] {
    const s = ls();
    if (!s) return [...mem.keys()];
    const out: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
    }
    return out;
  },
  clear(): void {
    for (const k of this.keys()) this.remove(k);
    mem.clear();
  },
};

export type KV = typeof kv;
