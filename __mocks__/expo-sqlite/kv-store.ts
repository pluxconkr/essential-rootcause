/**
 * Jest manual mock for expo-sqlite/kv-store: an in-memory SQLiteStorage with the same
 * synchronous + asynchronous surface the app uses. Lets tests exercise real persistence
 * paths (hydrate → write → hydrate) without a native SQLite binding.
 */
type Updater = (prev: string | null) => string;

export class SQLiteStorage {
  private static dbs = new Map<string, Map<string, string>>();
  private readonly map: Map<string, string>;

  constructor(private readonly databaseName: string) {
    if (!SQLiteStorage.dbs.has(databaseName)) SQLiteStorage.dbs.set(databaseName, new Map());
    this.map = SQLiteStorage.dbs.get(databaseName)!;
  }

  private write(key: string, value: string | Updater) {
    const next = typeof value === 'function' ? value(this.map.get(key) ?? null) : value;
    if (typeof next !== 'string') throw new Error(`[SQLiteStorage] Using ${typeof next} type for value is not supported. Use string instead.`);
    this.map.set(key, next);
  }

  getItemSync(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItemSync(key: string, value: string | Updater): void {
    this.write(key, value);
  }
  removeItemSync(key: string): boolean {
    return this.map.delete(key);
  }
  getAllKeysSync(): string[] {
    return Array.from(this.map.keys());
  }
  clearSync(): boolean {
    this.map.clear();
    return true;
  }
  getLengthSync(): number {
    return this.map.size;
  }
  closeSync(): void {}

  async getItemAsync(key: string) {
    return this.getItemSync(key);
  }
  async setItemAsync(key: string, value: string | Updater) {
    this.write(key, value);
  }
  async removeItemAsync(key: string) {
    return this.removeItemSync(key);
  }
  async getAllKeysAsync() {
    return this.getAllKeysSync();
  }
  async clearAsync() {
    return this.clearSync();
  }
  async getItem(key: string) {
    return this.getItemSync(key);
  }
  async setItem(key: string, value: string | Updater) {
    this.write(key, value);
  }
  async removeItem(key: string) {
    this.removeItemSync(key);
  }
  async getAllKeys() {
    return this.getAllKeysSync();
  }
  async clear() {
    this.clearSync();
  }
}

export const AsyncStorage = new SQLiteStorage('ExpoSQLiteStorage');
export const Storage = AsyncStorage;
export default AsyncStorage;
