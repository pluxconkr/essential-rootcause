/**
 * Supabase UsersRepo over app_user (plan §6). The row is normally created by the trigger on auth.users; upsertFromAuth
 * is the fallback for a session whose row is missing (first request racing the trigger). Only the columns the routes
 * need are read — home_geom and phone_e164 never leave the database (plan §6, §12). Server-only module.
 */
import type { ServiceClient } from '../../db';
import { logEvent } from '../../log';
import type { AuthProfile, UserRow, UsersRepo } from '../types';

const USER_COLUMNS = 'id, tenant_id, role, display_name, auth_provider, created_at';

/** The one tenant row (plan §6 "one row `pilot`"; supabase/seed.sql). Not the pilot-area slug EXPO_PUBLIC_PILOT. */
export const TENANT_SLUG = 'pilot';

export class SupabaseUsersRepo implements UsersRepo {
  private tenantId: string | null = null;

  constructor(private readonly client: ServiceClient) {}

  async getById(id: string): Promise<UserRow | null> {
    const { data, error } = await this.client.from('app_user').select(USER_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw new Error(`app_user read failed: ${error.message}`);
    return (data as UserRow | null) ?? null;
  }

  async upsertFromAuth(profile: AuthProfile): Promise<UserRow> {
    const existing = await this.getById(profile.id);
    if (existing) return existing;
    const tenant_id = await this.pilotTenantId();
    const { error } = await this.client
      .from('app_user')
      // auth_provider is NOT NULL; an unknown provider becomes 'email' exactly as the handle_new_auth_user trigger does.
      .upsert({ id: profile.id, tenant_id, role: 'resident', display_name: profile.displayName, auth_provider: profile.provider ?? 'email' }, { onConflict: 'id', ignoreDuplicates: true });
    if (error) logEvent('warn', 'users.upsert_failed', { message: error.message });
    return (await this.getById(profile.id)) ?? { id: profile.id, tenant_id, role: 'resident', display_name: profile.displayName, auth_provider: profile.provider, created_at: new Date().toISOString() };
  }

  /** tenant.id for TENANT_SLUG (plan §6: one row `pilot`). */
  async pilotTenantId(): Promise<string> {
    if (this.tenantId) return this.tenantId;
    const { data, error } = await this.client.from('tenant').select('id').eq('slug', TENANT_SLUG).maybeSingle();
    if (error || !data) throw new Error(`tenant ${TENANT_SLUG} not found${error ? `: ${error.message}` : ''}`);
    this.tenantId = String((data as { id: string }).id);
    return this.tenantId;
  }
}
