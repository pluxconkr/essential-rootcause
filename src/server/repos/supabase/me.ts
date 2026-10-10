/**
 * Supabase MeRepo over app_user, watch_area, device, report, report_vote, report_follow, report_comment and the
 * auth admin API (plan §6, §7 /me rows, §23.C). Column contract with supabase/migrations: 0001_init.sql for the
 * tables, 0002_me.sql for watch_area.label, watch_area.lat/lng (generated from geom) and deidentify_user(p_user,
 * p_now) → jsonb counts, which does the whole de-identification in one transaction. Reads throw on a database error
 * (the route answers 500); the auth admin calls report failure instead of throwing. Server-only module.
 */
import type { DeviceInput, MePatch, WatchArea, WatchAreaInput } from '@/domain/types';

import type { ServiceClient } from '../../db';
import { logEvent } from '../../log';
import { quietHoursOf, RESOLVED_STATUSES, type DeidentifyResult, type MeExportData, type MeRepo, type MeRow, type MeStats, type PhoneRow } from '../me';
import type { ReportRow, Repos } from '../types';

// phone_e164 is read only to derive phone_last4; it never sits on the row the route projects (plan §12).
const ME_COLUMNS = 'id, role, display_name, auth_provider, phone_e164, phone_verified_at, sms_opt_in, quiet_hours, apple_refresh_token, deleted_at, created_at';
const PHONE_COLUMNS = 'tenant_id, phone_e164, phone_verified_at, sms_opt_in';
const WATCH_COLUMNS = 'id, kind, label, lat, lng, radius_m, categories, schedule';

interface DbWatchArea {
  id: string;
  kind: WatchArea['kind'];
  label: string | null;
  lat: number | string;
  lng: number | string;
  radius_m: number | string;
  categories: WatchArea['categories'] | null;
  schedule: unknown;
}

const ewkt = (lat: number, lng: number) => `SRID=4326;POINT(${lng} ${lat})`;

function scheduleOf(v: unknown): WatchArea['schedule'] {
  if (!v || typeof v !== 'object') return null;
  const o = v as { days?: unknown; start?: unknown; end?: unknown };
  if (!Array.isArray(o.days) || typeof o.start !== 'string' || typeof o.end !== 'string') return null;
  return { days: o.days.filter((d): d is number => typeof d === 'number'), start: o.start, end: o.end };
}

function watchFromDb(w: DbWatchArea): WatchArea {
  return { id: w.id, kind: w.kind, label: w.label ?? '', lat: Number(w.lat), lng: Number(w.lng), radiusM: Math.round(Number(w.radius_m)), categories: w.categories ?? [], schedule: scheduleOf(w.schedule) };
}

/** WatchAreaInput → the columns to write; undefined keys are left out so a PATCH only touches what it names. */
function watchToDb(input: Partial<WatchAreaInput>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (input.kind !== undefined) row.kind = input.kind;
  if (input.label !== undefined) row.label = input.label;
  if (input.radiusM !== undefined) row.radius_m = input.radiusM;
  if (input.categories !== undefined) row.categories = input.categories;
  if (input.schedule !== undefined) row.schedule = input.schedule;
  if (input.lat !== undefined && input.lng !== undefined) row.geom = ewkt(input.lat, input.lng);
  return row;
}

export class SupabaseMeRepo implements MeRepo {
  constructor(
    private readonly client: ServiceClient,
    private readonly repos: Repos,
  ) {}

  async getMe(userId: string): Promise<MeRow | null> {
    const { data, error } = await this.client.from('app_user').select(ME_COLUMNS).eq('id', userId).maybeSingle();
    if (error) throw new Error(`app_user read failed: ${error.message}`);
    if (!data) return null;
    const { phone_e164, ...r } = data as unknown as Omit<MeRow, 'email' | 'quiet_hours' | 'phone_last4'> & { phone_e164: string | null; quiet_hours: unknown };
    return { ...r, auth_provider: r.auth_provider ?? 'email', phone_last4: typeof phone_e164 === 'string' && phone_e164.length > 0 ? phone_e164.slice(-4) : null, sms_opt_in: r.sms_opt_in === true, quiet_hours: quietHoursOf(r.quiet_hours), email: await this.email(userId) };
  }

  async getStats(userId: string): Promise<MeStats> {
    const [filed, resolved, votes] = await Promise.all([
      this.count('report', (q) => q.eq('reporter_id', userId)),
      this.count('report', (q) => q.eq('reporter_id', userId).in('status', [...RESOLVED_STATUSES])),
      this.count('report_vote', (q) => q.eq('user_id', userId)),
    ]);
    return { filed, resolved, votes };
  }

  async patchMe(userId: string, patch: MePatch): Promise<void> {
    const row: Record<string, unknown> = {};
    if (patch.displayName !== undefined) row.display_name = patch.displayName?.trim() || null;
    if (patch.quietHours !== undefined) row.quiet_hours = patch.quietHours;
    if (patch.smsOptIn !== undefined) row.sms_opt_in = patch.smsOptIn;
    if (Object.keys(row).length === 0) return;
    const { error } = await this.client.from('app_user').update(row).eq('id', userId);
    if (error) throw new Error(`app_user update failed: ${error.message}`);
  }

  async listWatchAreas(userId: string): Promise<WatchArea[]> {
    const { data, error } = await this.client.from('watch_area').select(WATCH_COLUMNS).eq('user_id', userId).order('created_at', { ascending: true });
    if (error) throw new Error(`watch_area read failed: ${error.message}`);
    return ((data ?? []) as unknown as DbWatchArea[]).map(watchFromDb);
  }

  async createWatchArea(userId: string, input: WatchAreaInput): Promise<WatchArea> {
    const { data, error } = await this.client
      .from('watch_area')
      .insert({ user_id: userId, ...watchToDb(input) })
      .select(WATCH_COLUMNS)
      .single();
    if (error || !data) throw new Error(`watch_area insert failed: ${error?.message ?? 'no row'}`);
    return watchFromDb(data as unknown as DbWatchArea);
  }

  async updateWatchArea(userId: string, id: string, input: Partial<WatchAreaInput>): Promise<WatchArea | null> {
    const row = watchToDb(input);
    const query = Object.keys(row).length === 0 ? this.client.from('watch_area').select(WATCH_COLUMNS).eq('id', id).eq('user_id', userId).maybeSingle() : this.client.from('watch_area').update(row).eq('id', id).eq('user_id', userId).select(WATCH_COLUMNS).maybeSingle();
    const { data, error } = await query;
    if (error) throw new Error(`watch_area update failed: ${error.message}`);
    return data ? watchFromDb(data as unknown as DbWatchArea) : null;
  }

  async deleteWatchArea(userId: string, id: string): Promise<boolean> {
    const { data, error } = await this.client.from('watch_area').delete().eq('id', id).eq('user_id', userId).select('id');
    if (error) throw new Error(`watch_area delete failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  async upsertDevice(userId: string, input: DeviceInput, now: string): Promise<void> {
    const { error } = await this.client.from('device').upsert({ user_id: userId, expo_push_token: input.expoPushToken, platform: input.platform, install_id: input.installId, last_seen_at: now }, { onConflict: 'expo_push_token' });
    if (error) throw new Error(`device upsert failed: ${error.message}`);
  }

  async listOwnReports(userId: string, limit: number): Promise<ReportRow[]> {
    const { data, error } = await this.client.from('report').select('id').eq('reporter_id', userId).order('created_at', { ascending: false }).limit(limit);
    if (error) throw new Error(`report read failed: ${error.message}`);
    // One full read per report (photos, events, counts): "My reports" is short by construction (limit), so no extra RPC.
    const rows = await Promise.all(((data ?? []) as { id: string }[]).map((r) => this.repos.reports.getPublicById(r.id)));
    return rows.filter((r): r is ReportRow => r !== null);
  }

  async exportData(userId: string): Promise<MeExportData> {
    const [votes, follows, comments, devices] = await Promise.all([
      this.rows<{ report_id: string; created_at: string }>('report_vote', 'report_id, created_at', userId),
      this.rows<{ report_id: string }>('report_follow', 'report_id', userId),
      this.rows<{ report_id: string; body: string; created_at: string }>('report_comment', 'report_id, body, created_at', userId),
      this.rows<{ platform: string; last_seen_at: string }>('device', 'platform, last_seen_at', userId),
    ]);
    return {
      votes: votes.map((v) => ({ reportId: v.report_id, at: v.created_at })),
      follows: follows.map((f) => f.report_id),
      comments: comments.map((c) => ({ reportId: c.report_id, body: c.body, at: c.created_at })),
      devices: devices.map((d) => ({ platform: d.platform, lastSeenAt: d.last_seen_at })),
    };
  }

  async setAppleRefreshToken(userId: string, sealed: string | null): Promise<void> {
    const { error } = await this.client.from('app_user').update({ apple_refresh_token: sealed }).eq('id', userId);
    if (error) throw new Error(`app_user update failed: ${error.message}`);
  }

  async getPhone(userId: string): Promise<PhoneRow | null> {
    const { data, error } = await this.client.from('app_user').select(PHONE_COLUMNS).eq('id', userId).maybeSingle();
    if (error) throw new Error(`app_user read failed: ${error.message}`);
    const r = data as unknown as { tenant_id: string; phone_e164: string | null; phone_verified_at: string | null; sms_opt_in: boolean | null } | null;
    if (!r || typeof r.phone_e164 !== 'string' || r.phone_e164.length === 0) return null;
    return { tenant_id: String(r.tenant_id), phone_e164: r.phone_e164, phone_verified_at: r.phone_verified_at, sms_opt_in: r.sms_opt_in === true };
  }

  async startPhoneVerification(userId: string, phoneE164: string): Promise<void> {
    const { error } = await this.client.from('app_user').update({ phone_e164: phoneE164, phone_verified_at: null, sms_opt_in: false }).eq('id', userId);
    if (error) throw new Error(`app_user update failed: ${error.message}`);
  }

  async setPhoneVerified(userId: string, now: string): Promise<void> {
    const { error } = await this.client.from('app_user').update({ phone_verified_at: now }).eq('id', userId);
    if (error) throw new Error(`app_user update failed: ${error.message}`);
  }

  async deidentify(userId: string, now: string): Promise<DeidentifyResult> {
    // contract: supabase/migrations/0002_me.sql deidentify_user(p_user uuid, p_now timestamptz) → jsonb counts, one transaction.
    const { data, error } = await this.client.rpc('deidentify_user', { p_user: userId, p_now: now });
    if (error) throw new Error(`deidentify_user failed: ${error.message}`);
    const d = (data ?? {}) as Record<string, unknown>;
    const n = (k: string) => Number(d[k] ?? 0) || 0;
    return { reports: n('reports'), photos: n('photos'), comments: n('comments'), votes: n('votes'), follows: n('follows'), devices: n('devices'), watchAreas: n('watch_areas'), orphanVoteWeight: n('orphan_vote_weight') };
  }

  async deleteAuthUser(userId: string): Promise<boolean> {
    const { error } = await this.client.auth.admin.deleteUser(userId);
    if (error) {
      logEvent('warn', 'me.auth_delete_failed', { message: error.message, status: error.status });
      return false;
    }
    return true;
  }

  // ---------- helpers ----------

  /** auth.users.email through the admin API; null when the user is gone or the call fails (the profile still renders). */
  private async email(userId: string): Promise<string | null> {
    try {
      const { data, error } = await this.client.auth.admin.getUserById(userId);
      if (error) {
        logEvent('warn', 'me.auth_read_failed', { message: error.message });
        return null;
      }
      return data.user?.email ?? null;
    } catch {
      return null;
    }
  }

  private async count(table: string, where: (q: ReturnType<ReturnType<ServiceClient['from']>['select']>) => PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number> {
    const { count, error } = await where(this.client.from(table).select('*', { count: 'exact', head: true }));
    if (error) throw new Error(`${table} count failed: ${error.message}`);
    return count ?? 0;
  }

  private async rows<T>(table: string, columns: string, userId: string): Promise<T[]> {
    const { data, error } = await this.client.from(table).select(columns).eq('user_id', userId);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    return (data ?? []) as unknown as T[];
  }
}
