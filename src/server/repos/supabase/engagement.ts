/**
 * Supabase EngagementRepo over report_vote / report_follow / report_comment / content_flag / report_event, the report
 * counters, and the account columns a vote or a status push needs (plan §6, §7, §9.4). One statement per call, no
 * embedded joins (comment author names are fetched in batch afterwards, like repos/supabase/reports.ts). Duplicate
 * votes and follows are detected by the primary-key violation (23505) so two phones racing still produce one row.
 * Writes throw on a database error so the route answers 500; the lookups a push can live without (devices, names)
 * log and return empty.
 *
 * Column contract with supabase/migrations/0001_init.sql:
 *   - report_vote (report_id, user_id) PK, weight, unverified_geo, install_id, created_at;
 *   - report_follow (report_id, user_id) PK; report_comment id default, hidden, is_internal, is_staff;
 *   - content_flag target_type flag_target, reason text, status default 'open';
 *   - report.vote_count / score / score_terms / flags / updated_at / reporter_vote_weight / orphan_vote_weight;
 *   - app_user.created_at / quiet_hours / home_geom and watch_area.geom (kind 'home') are geography columns, which
 *     PostgREST returns as hex EWKB (or GeoJSON when cast) — pointFromDb() reads either, and never the raw value leaves.
 * Server-only module.
 */
import type { LatLng } from '@/domain/geo';

import type { ServiceClient } from '../../db';
import { logEvent } from '../../log';
import type { CommentInsert, CommentRow, DeviceRow, EngagementRepo, EventInput, FlagInsert, FlagRow, ReportCounters, UserContext, VoteRow } from '../engagement';

const UNIQUE_VIOLATION = '23505';
const COMMENT_COLUMNS = 'id, report_id, user_id, body, is_staff, is_internal, hidden, created_at';
const FLAG_COLUMNS = 'id, target_type, target_id, reporter_id, reason, status, created_at';

type DbComment = Omit<CommentRow, 'author_display_name'>;

/**
 * A PostGIS point as PostgREST hands it over: GeoJSON {type:'Point', coordinates:[lng, lat]}, EWKB/WKB hex
 * ("0101000020E6100000…"), or WKT "SRID=4326;POINT(lng lat)". null for anything else — a vote then counts as
 * unverified_geo rather than failing.
 */
export function pointFromDb(value: unknown): LatLng | null {
  if (!value) return null;
  if (typeof value === 'object') {
    const g = value as { type?: unknown; coordinates?: unknown };
    if (g.type !== 'Point' || !Array.isArray(g.coordinates) || g.coordinates.length < 2) return null;
    return finitePoint(Number(g.coordinates[1]), Number(g.coordinates[0]));
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const wkt = /^(?:SRID=\d+;)?POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/i.exec(text);
  if (wkt) return finitePoint(Number(wkt[2]), Number(wkt[1]));
  if (!/^[0-9a-f]+$/i.test(text) || text.length % 2 !== 0 || text.length < 42) return null;
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  const view = new DataView(bytes.buffer);
  const little = bytes[0] === 1;
  let offset = 1;
  const type = view.getUint32(offset, little);
  offset += 4;
  if ((type & 0x0fffffff) !== 1) return null; // wkbPoint; Z/M variants are never written for these columns
  if (type & 0x20000000) offset += 4; // EWKB SRID flag
  if (bytes.length < offset + 16) return null;
  return finitePoint(view.getFloat64(offset + 8, little), view.getFloat64(offset, little));
}

function finitePoint(lat: number, lng: number): LatLng | null {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

function quietHoursFromDb(value: unknown): UserContext['quiet_hours'] {
  if (!value || typeof value !== 'object') return null;
  const q = value as { start?: unknown; end?: unknown };
  return typeof q.start === 'string' && typeof q.end === 'string' ? { start: q.start, end: q.end } : null;
}

export class SupabaseEngagementRepo implements EngagementRepo {
  constructor(private readonly client: ServiceClient) {}

  // ---------- votes ----------

  async addVote(row: VoteRow): Promise<boolean> {
    const { error } = await this.client.from('report_vote').insert({ report_id: row.report_id, user_id: row.user_id, weight: row.weight, unverified_geo: row.unverified_geo, install_id: row.install_id, created_at: row.created_at });
    if (!error) return true;
    if (error.code === UNIQUE_VIOLATION) return false;
    throw new Error(`report_vote insert failed: ${error.message}`);
  }

  async removeVote(reportId: string, userId: string): Promise<boolean> {
    const { data, error } = await this.client.from('report_vote').delete().eq('report_id', reportId).eq('user_id', userId).select('report_id');
    if (error) throw new Error(`report_vote delete failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  async voteWeightSum(reportId: string): Promise<number> {
    const [votes, report] = await Promise.all([this.client.from('report_vote').select('weight').eq('report_id', reportId), this.client.from('report').select('reporter_vote_weight, orphan_vote_weight').eq('id', reportId).maybeSingle()]);
    if (votes.error) throw new Error(`report_vote read failed: ${votes.error.message}`);
    if (report.error) throw new Error(`report read failed: ${report.error.message}`);
    const own = report.data as { reporter_vote_weight?: unknown; orphan_vote_weight?: unknown } | null;
    const base = Number(own?.reporter_vote_weight ?? 0) + Number(own?.orphan_vote_weight ?? 0);
    return ((votes.data ?? []) as { weight: unknown }[]).reduce((sum, v) => sum + Number(v.weight ?? 0), Number.isFinite(base) ? base : 0);
  }

  // ---------- counters and timeline ----------

  async updateCounters(reportId: string, c: ReportCounters): Promise<void> {
    const { error } = await this.client.from('report').update({ vote_count: c.vote_count, score: c.score, score_terms: c.score_terms, flags: c.flags, updated_at: c.updated_at }).eq('id', reportId);
    if (error) throw new Error(`report counters update failed: ${error.message}`);
  }

  async appendEvent(reportId: string, e: EventInput): Promise<void> {
    const { error } = await this.client.from('report_event').insert({ report_id: reportId, kind: e.kind, actor_type: e.actor_type, actor_id: e.actor_id, from_status: e.from_status, to_status: e.to_status, note: e.note, created_at: e.created_at });
    if (error) throw new Error(`report_event insert failed: ${error.message}`);
  }

  // ---------- follows ----------

  async follow(reportId: string, userId: string, now: string): Promise<boolean> {
    const { error } = await this.client.from('report_follow').insert({ report_id: reportId, user_id: userId, created_at: now });
    if (!error) return true;
    if (error.code === UNIQUE_VIOLATION) return false;
    throw new Error(`report_follow insert failed: ${error.message}`);
  }

  async unfollow(reportId: string, userId: string): Promise<boolean> {
    const { data, error } = await this.client.from('report_follow').delete().eq('report_id', reportId).eq('user_id', userId).select('report_id');
    if (error) throw new Error(`report_follow delete failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  async followerIds(reportId: string): Promise<string[]> {
    const { data, error } = await this.client.from('report_follow').select('user_id').eq('report_id', reportId);
    if (error) {
      logEvent('warn', 'engagement.followers_failed', { message: error.message });
      return [];
    }
    return ((data ?? []) as { user_id: string }[]).map((f) => f.user_id);
  }

  // ---------- comments ----------

  async addComment(input: CommentInsert): Promise<CommentRow> {
    const { data, error } = await this.client.from('report_comment').insert({ report_id: input.report_id, user_id: input.user_id, body: input.body, is_staff: input.is_staff, is_internal: input.is_internal, hidden: input.hidden, created_at: input.created_at }).select(COMMENT_COLUMNS).single();
    if (error || !data) throw new Error(`report_comment insert failed: ${error?.message ?? 'no row'}`);
    const row = data as unknown as DbComment;
    const names = await this.displayNames([row.user_id]);
    return { ...row, author_display_name: names.get(row.user_id ?? '') ?? null };
  }

  async getComment(id: string): Promise<CommentRow | null> {
    const { data, error } = await this.client.from('report_comment').select(COMMENT_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw new Error(`report_comment read failed: ${error.message}`);
    if (!data) return null;
    const row = data as unknown as DbComment;
    const names = await this.displayNames([row.user_id]);
    return { ...row, author_display_name: names.get(row.user_id ?? '') ?? null };
  }

  async listComments(reportId: string, opts: { includeInternal: boolean }): Promise<CommentRow[]> {
    let query = this.client.from('report_comment').select(COMMENT_COLUMNS).eq('report_id', reportId).eq('hidden', false);
    if (!opts.includeInternal) query = query.eq('is_internal', false);
    const { data, error } = await query.order('created_at', { ascending: true });
    if (error) throw new Error(`report_comment list failed: ${error.message}`);
    const rows = (data ?? []) as unknown as DbComment[];
    const names = await this.displayNames(rows.map((r) => r.user_id));
    return rows.map((r) => ({ ...r, author_display_name: names.get(r.user_id ?? '') ?? null }));
  }

  // ---------- flags ----------

  async addFlag(input: FlagInsert): Promise<FlagRow> {
    const { data, error } = await this.client.from('content_flag').insert({ target_type: input.target_type, target_id: input.target_id, reporter_id: input.reporter_id, reason: input.reason, created_at: input.created_at }).select(FLAG_COLUMNS).single();
    if (error || !data) throw new Error(`content_flag insert failed: ${error?.message ?? 'no row'}`);
    return data as unknown as FlagRow;
  }

  // ---------- accounts and devices ----------

  async userContext(userId: string): Promise<UserContext | null> {
    const { data, error } = await this.client.from('app_user').select('id, created_at, quiet_hours, home_geom').eq('id', userId).maybeSingle();
    if (error) throw new Error(`app_user read failed: ${error.message}`);
    if (!data) return null;
    const user = data as { id: string; created_at: string; quiet_hours: unknown; home_geom: unknown };
    const area = await this.client.from('watch_area').select('geom').eq('user_id', userId).eq('kind', 'home').limit(1).maybeSingle();
    if (area.error) logEvent('warn', 'engagement.watch_area_failed', { message: area.error.message });
    const home = pointFromDb((area.data as { geom?: unknown } | null)?.geom) ?? pointFromDb(user.home_geom);
    return { id: user.id, created_at: user.created_at, home, quiet_hours: quietHoursFromDb(user.quiet_hours) };
  }

  async devicesFor(userIds: readonly string[]): Promise<DeviceRow[]> {
    const wanted = Array.from(new Set(userIds));
    if (wanted.length === 0) return [];
    const { data, error } = await this.client.from('device').select('user_id, expo_push_token, platform').in('user_id', wanted);
    if (error) {
      logEvent('warn', 'engagement.devices_failed', { message: error.message });
      return [];
    }
    return (data ?? []) as DeviceRow[];
  }

  // ---------- helpers ----------

  private async displayNames(ids: readonly (string | null)[]): Promise<Map<string, string | null>> {
    const wanted = Array.from(new Set(ids.filter((x): x is string => x !== null)));
    const out = new Map<string, string | null>();
    if (wanted.length === 0) return out;
    const { data, error } = await this.client.from('app_user').select('id, display_name').in('id', wanted);
    if (error) {
      logEvent('warn', 'engagement.display_names_failed', { message: error.message });
      return out;
    }
    for (const u of (data ?? []) as { id: string; display_name: string | null }[]) out.set(u.id, u.display_name);
    return out;
  }
}
