/**
 * In-memory UsersRepo for route tests and the dev server (plan §14 "route tests … against repos/memory/*").
 * Deterministic: seeded rows keep their timestamps; rows created from a session get a fixed clock. Server-only module.
 */
import type { AuthProfile, UserRow, UsersRepo } from '../types';

export const MEMORY_TENANT_ID = 'pilot';
export const MEMORY_EPOCH = '2026-01-01T00:00:00.000Z';

export class MemoryUsersRepo implements UsersRepo {
  private readonly rows = new Map<string, UserRow>();

  constructor(seed: readonly UserRow[] = []) {
    for (const u of seed) this.rows.set(u.id, { ...u });
  }

  /** Insert or replace a row (tests). */
  seed(user: Partial<UserRow> & { id: string }): UserRow {
    const row: UserRow = { tenant_id: MEMORY_TENANT_ID, role: 'resident', display_name: null, auth_provider: null, created_at: MEMORY_EPOCH, ...user };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async getById(id: string): Promise<UserRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async upsertFromAuth(profile: AuthProfile): Promise<UserRow> {
    const existing = this.rows.get(profile.id);
    if (existing) return { ...existing };
    return this.seed({ id: profile.id, display_name: profile.displayName, auth_provider: profile.provider });
  }
}
