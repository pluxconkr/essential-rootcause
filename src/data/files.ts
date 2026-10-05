/**
 * Offline file storage under the app's document directory (never the purgeable cache).
 * Used for downloaded JSON assets. Web gets `files.web.ts`.
 */
import { Directory, File, Paths } from 'expo-file-system';

let dir: Directory | null = null;

function offlineDir(): Directory {
  if (!dir) {
    dir = new Directory(Paths.document, 'offline');
    try {
      dir.create({ intermediates: true, idempotent: true });
    } catch {
      /* exists */
    }
  }
  return dir;
}

export const files = {
  readJsonSync<T>(name: string): T | null {
    try {
      const f = new File(offlineDir(), name);
      if (!f.exists) return null;
      return JSON.parse(f.textSync()) as T;
    } catch {
      return null;
    }
  },
  writeJson(name: string, data: unknown): number {
    const raw = JSON.stringify(data);
    try {
      const f = new File(offlineDir(), name);
      f.write(raw);
      return f.size;
    } catch (e) {
      if (__DEV__) console.warn('[files] write failed', name, e);
      return 0;
    }
  },
  bytesOf(name: string): number {
    try {
      const f = new File(offlineDir(), name);
      return f.exists ? f.size : 0;
    } catch {
      return 0;
    }
  },
  remove(name: string): void {
    try {
      const f = new File(offlineDir(), name);
      if (f.exists) f.delete();
    } catch {
      /* ignore */
    }
  },
  availableBytes(): number {
    try {
      return Paths.availableDiskSpace;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  },
};

export type Files = typeof files;
