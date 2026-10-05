/**
 * Supabase ReportsRepo over report / report_event / report_vote / report_follow / report_photo / report_comment
 * (plan §6) and the RPCs find_duplicates and reports_in_bbox. Queries stay simple — one statement each, no embedded
 * joins; reporter names and photos are fetched in batch afterwards. Reads throw on a database error so the route
 * answers 500 and the phone keeps its cache (an empty 200 would wipe it); the duplicate search is best-effort.
 *
 * Column contract with supabase/migrations (flagged in the M0 hand-off):
 *   - report exposes lat, lng, public_lat, public_lng as readable columns generated from geom / geom_public and
 *     accepts geom / geom_public as EWKT text on insert; updated_at exists and defaults to created_at;
 *   - find_duplicates(p_tenant, p_lat, p_lng, p_category, p_radius_m) → rows {id, subtype, status, distance_m, …} of open reports;
 *   - reports_in_bbox(p_min_lng, p_min_lat, p_max_lng, p_max_lat, p_category, p_status, p_sort, p_cursor_id, p_limit)
 *     → report rows (REPORT_COLUMNS) plus comment_count, filtered on geom_public, ordered by p_sort ('score' |
 *     'newest') with a keyset continuing after the row p_cursor_id; nulls mean "no filter";
 *   - photos live in the private bucket PHOTO_BUCKET and are served through 1 h signed URLs (plan §12).
 * Server-only module.
 */
import { dupRadiusM, subtypeDef } from '@/domain/taxonomy';
import type { CreateReportInput, PhotoPhase, ReportStatus, Subtype } from '@/domain/types';

import type { ServiceClient } from '../../db';
import { logEvent } from '../../log';
import { ZERO_TERMS, deriveReportFields } from '../derive';
import type { CreateReportCtx, CreateReportResult, DuplicateCandidate, ListPublicQuery, ListPublicResult, ReportEventRow, ReportPhotoRow, ReportRow, ReportsRepo } from '../types';
import type { SupabaseUsersRepo } from './users';

export const PHOTO_BUCKET = 'photos';
export const SIGNED_URL_TTL_SEC = 3600; // spec: plan §12 signed URLs (1 h)

const REPORT_COLUMNS =
  'id, tenant_id, client_draft_id, reporter_id, reporter_display, category, subtype, status, severity_resident, severity_ai, severity_confirmed, emergency_requested, injury_flag, ada_flag, storm_sensitivity, lat, lng, public_lat, public_lng, address_text, address_confidence, score, score_terms, storm_multiplier, vote_count, reporter_vote_weight, cluster_candidate, flags, created_at, updated_at';

/** What PostgREST returns for REPORT_COLUMNS: loosely typed, normalised by fromDb(). */
type DbReport = Omit<ReportRow, 'reporter_display_name' | 'photos' | 'events' | 'comment_count' | 'storm_sensitivity' | 'score_terms' | 'flags' | 'address_text' | 'updated_at'> & {
  storm_sensitivity: ReportRow['storm_sensitivity'] | null;
  score_terms: ReportRow['score_terms'] | null;
  flags: Record<string, boolean> | null;
  address_text: string | null;
  updated_at: string | null;
  comment_count?: number | string | null;
};

interface DbPhoto {
  id: string;
  report_id: string;
  phase: PhotoPhase;
  visibility: 'staff_only' | 'public';
  uploader_id: string | null;
  storage_key: string;
  thumb_key: string;
}

const ewkt = (lat: number, lng: number) => `SRID=4326;POINT(${lng} ${lat})`;

function fromDb(r: DbReport, reporterName: string | null, photos: ReportPhotoRow[], events: ReportEventRow[], commentCount: number): ReportRow {
  return {
    ...r,
    reporter_display_name: reporterName,
    storm_sensitivity: r.storm_sensitivity ?? [],
    score_terms: r.score_terms ?? { ...ZERO_TERMS },
    flags: r.flags ?? {},
    address_text: r.address_text ?? '',
    score: Number(r.score),
    storm_multiplier: Number(r.storm_multiplier ?? 1),
    reporter_vote_weight: Number(r.reporter_vote_weight ?? 0),
    updated_at: r.updated_at ?? r.created_at,
    photos,
    events,
    comment_count: commentCount,
  };
}

export class SupabaseReportsRepo implements ReportsRepo {
  constructor(
    private readonly client: ServiceClient,
    private readonly users: SupabaseUsersRepo,
  ) {}

  async create(input: CreateReportInput, ctx: CreateReportCtx): Promise<CreateReportResult> {
    const replay = await this.findByDraftId(input.clientDraftId);
    if (replay) return { row: replay, created: false };

    const id = crypto.randomUUID();
    const tenant_id = await this.users.pilotTenantId();
    const duplicates = await this.findDuplicates(input.lat, input.lng, input.subtype);
    const d = deriveReportFields(input, id, ctx);
    const { error } = await this.client.from('report').insert({
      id: d.id,
      tenant_id,
      client_draft_id: d.client_draft_id,
      reporter_id: d.reporter_id,
      reporter_display: d.reporter_display,
      category: d.category,
      subtype: d.subtype,
      status: d.status,
      severity_resident: d.severity_resident,
      emergency_requested: d.emergency_requested,
      injury_flag: d.injury_flag,
      ada_flag: d.ada_flag,
      storm_sensitivity: d.storm_sensitivity,
      geom: ewkt(d.lat, d.lng),
      geom_public: ewkt(d.public_lat, d.public_lng),
      address_text: d.address_text || null,
      address_confidence: d.address_confidence,
      score: d.score,
      score_terms: d.score_terms,
      storm_multiplier: d.storm_multiplier,
      vote_count: d.vote_count,
      reporter_vote_weight: d.reporter_vote_weight,
      cluster_candidate: duplicates[0]?.id ?? null,
      flags: d.flags,
      created_at: d.created_at,
      updated_at: d.updated_at,
    });
    if (error) {
      // 23505 = unique_violation on client_draft_id: a concurrent replay won the race (plan §4 flow 3).
      if (error.code === '23505') {
        const winner = await this.findByDraftId(input.clientDraftId);
        if (winner) return { row: winner, created: false };
      }
      throw new Error(`report insert failed: ${error.message}`);
    }

    const note = input.note?.trim() || null;
    const ev = await this.client.from('report_event').insert({ report_id: id, actor_type: 'resident', actor_id: d.reporter_id, from_status: null, to_status: 'new', kind: 'created', note, created_at: ctx.now });
    if (ev.error) logEvent('warn', 'reports.event_insert_failed', { requestId: ctx.requestId, message: ev.error.message });

    if (d.reporter_id) {
      // Named/Initials: the reporter's own vote and follow rows; Anonymous keeps only reporter_vote_weight (plan §3.4).
      const vote = await this.client.from('report_vote').insert({ report_id: id, user_id: d.reporter_id, weight: d.reporter_vote_weight, created_at: ctx.now });
      if (vote.error) logEvent('warn', 'reports.vote_insert_failed', { requestId: ctx.requestId, message: vote.error.message });
      const follow = await this.client.from('report_follow').insert({ report_id: id, user_id: d.reporter_id });
      if (follow.error) logEvent('warn', 'reports.follow_insert_failed', { requestId: ctx.requestId, message: follow.error.message });
    }

    const row = await this.getPublicById(id);
    if (!row) throw new Error('report vanished after insert');
    return { row, created: true };
  }

  async getPublicById(id: string): Promise<ReportRow | null> {
    const { data, error } = await this.client.from('report').select(REPORT_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw new Error(`report read failed: ${error.message}`);
    if (!data) return null;
    const r = data as unknown as DbReport;
    const [names, photos, events, commentCount] = await Promise.all([this.reporterNames([r.reporter_id]), this.publicPhotos([r.id]), this.events(r.id), this.commentCount(r.id)]);
    return fromDb(r, names.get(r.reporter_id ?? '') ?? null, photos.get(r.id) ?? [], events, commentCount);
  }

  async listPublic(q: ListPublicQuery): Promise<ListPublicResult> {
    const p_tenant = await this.users.pilotTenantId();
    const { data, error } = await this.client.rpc('reports_in_bbox', {
      p_tenant,
      p_min_lng: q.bbox?.minLng ?? null,
      p_min_lat: q.bbox?.minLat ?? null,
      p_max_lng: q.bbox?.maxLng ?? null,
      p_max_lat: q.bbox?.maxLat ?? null,
      p_category: q.category,
      p_status: q.status,
      p_sort: q.sort,
      p_cursor_id: q.cursor,
      p_limit: q.limit + 1,
    });
    if (error) throw new Error(`reports_in_bbox failed: ${error.message}`);
    const all = (data ?? []) as DbReport[];
    const page = all.slice(0, q.limit);
    const nextCursor = all.length > q.limit && page.length > 0 ? page[page.length - 1].id : null;
    const reporterIds = page.map((r) => r.reporter_id).filter((x): x is string => x !== null);
    const [names, photos] = await Promise.all([this.reporterNames(reporterIds), this.publicPhotos(page.map((r) => r.id))]);
    return { rows: page.map((r) => fromDb(r, names.get(r.reporter_id ?? '') ?? null, photos.get(r.id) ?? [], [], Number(r.comment_count ?? 0))), nextCursor };
  }

  async findDuplicates(lat: number, lng: number, subtype: Subtype): Promise<DuplicateCandidate[]> {
    const p_tenant = await this.users.pilotTenantId();
    const { data, error } = await this.client.rpc('find_duplicates', { p_tenant, p_lat: lat, p_lng: lng, p_category: subtypeDef(subtype).category, p_radius_m: dupRadiusM(subtype) });
    if (error) {
      logEvent('warn', 'reports.find_duplicates_failed', { message: error.message });
      return [];
    }
    return ((data ?? []) as { id: string; subtype: Subtype; status: ReportStatus; distance_m: number | string }[]).map((d) => ({ id: d.id, subtype: d.subtype, status: d.status, distance_m: Number(d.distance_m) }));
  }

  // ---------- helpers ----------

  private async findByDraftId(clientDraftId: string): Promise<ReportRow | null> {
    const { data, error } = await this.client.from('report').select('id').eq('client_draft_id', clientDraftId).maybeSingle();
    if (error) throw new Error(`report lookup failed: ${error.message}`);
    return data ? this.getPublicById((data as { id: string }).id) : null;
  }

  private async reporterNames(ids: readonly (string | null)[]): Promise<Map<string, string | null>> {
    const wanted = Array.from(new Set(ids.filter((x): x is string => x !== null)));
    const out = new Map<string, string | null>();
    if (wanted.length === 0) return out;
    const { data, error } = await this.client.from('app_user').select('id, display_name').in('id', wanted);
    if (error) {
      logEvent('warn', 'reports.reporter_names_failed', { message: error.message });
      return out;
    }
    for (const u of (data ?? []) as { id: string; display_name: string | null }[]) out.set(u.id, u.display_name);
    return out;
  }

  /** Public photos per report with signed URLs; staff-only photos are never loaded for public views (plan §12). */
  private async publicPhotos(reportIds: readonly string[]): Promise<Map<string, ReportPhotoRow[]>> {
    const out = new Map<string, ReportPhotoRow[]>();
    if (reportIds.length === 0) return out;
    const { data, error } = await this.client.from('report_photo').select('id, report_id, phase, visibility, uploader_id, storage_key, thumb_key').in('report_id', reportIds).eq('visibility', 'public');
    if (error) {
      logEvent('warn', 'reports.photos_failed', { message: error.message });
      return out;
    }
    const photos = (data ?? []) as DbPhoto[];
    if (photos.length === 0) return out;
    const keys = Array.from(new Set(photos.flatMap((p) => [p.storage_key, p.thumb_key])));
    const signed = await this.client.storage.from(PHOTO_BUCKET).createSignedUrls(keys, SIGNED_URL_TTL_SEC);
    const urlFor = new Map<string, string>();
    for (const s of signed.data ?? []) if (s.path && s.signedUrl) urlFor.set(s.path, s.signedUrl);
    for (const p of photos) {
      const url = urlFor.get(p.storage_key);
      const thumb = urlFor.get(p.thumb_key);
      if (!url || !thumb) continue;
      const list = out.get(p.report_id) ?? [];
      list.push({ id: p.id, phase: p.phase, visibility: p.visibility, uploader_id: p.uploader_id, url, thumb_url: thumb });
      out.set(p.report_id, list);
    }
    return out;
  }

  private async events(reportId: string): Promise<ReportEventRow[]> {
    const { data, error } = await this.client.from('report_event').select('id, kind, actor_type, actor_id, from_status, to_status, note, created_at').eq('report_id', reportId).order('created_at', { ascending: true });
    if (error) {
      logEvent('warn', 'reports.events_failed', { message: error.message });
      return [];
    }
    return (data ?? []) as ReportEventRow[];
  }

  /** Visible, non-internal comments (plan §12: internal notes never leave the console). */
  private async commentCount(reportId: string): Promise<number> {
    const { count, error } = await this.client.from('report_comment').select('id', { count: 'exact', head: true }).eq('report_id', reportId).eq('hidden', false).eq('is_internal', false);
    if (error) {
      logEvent('warn', 'reports.comment_count_failed', { message: error.message });
      return 0;
    }
    return count ?? 0;
  }
}
