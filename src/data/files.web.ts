/**
 * Web fallback for file storage. Mirrors small JSON blobs into localStorage via the kv module.
 */
import { kv } from './kv';

const key = (name: string) => `file:${name}`;

export const files = {
  readJsonSync<T>(name: string): T | null {
    return kv.get<T>(key(name));
  },
  writeJson(name: string, data: unknown): number {
    kv.set(key(name), data);
    return JSON.stringify(data).length;
  },
  bytesOf(name: string): number {
    const v = kv.get<unknown>(key(name));
    return v == null ? 0 : JSON.stringify(v).length;
  },
  remove(name: string): void {
    kv.remove(key(name));
  },
  availableBytes(): number {
    return Number.POSITIVE_INFINITY;
  },
};

export type Files = typeof files;
