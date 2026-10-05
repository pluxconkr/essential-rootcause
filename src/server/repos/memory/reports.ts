/**
 * In-memory ReportsRepo for route tests and the dev server: deterministic ids (rc_000001…), the same derivation as
 * production (repos/derive.ts), the duplicate search done with geo.distanceM over dupRadiusM(subtype) (plan §6
 * find_duplicates) and the same cursor semantics as the reports_in_bbox RPC (cursor = id of the last row). State
 * lives in the instance; tests create a fresh one. Server-only module.
 */
import { distanceM, inBBox } from '@/domain/geo';
import { dupRadiusM, subtypeDef } from '@/domain/taxonomy';
import type { CreateReportInput, ReportStatus, Subtype } from '@/domain/types';

import { deriveReportFields } from '../derive';
import type { CreateReportCtx, CreateReportResult, DuplicateCandidate, ListPublicQuery, ListPublicResult, ReportRow, ReportsRepo, UsersRepo } from '../types';
import { MEMORY_TENANT_ID } from './users';

/** Statuses a duplicate candidate may have: anything not closed out (plan §6 "open reports"). */
export const OPEN_STATUSES: readonly ReportStatus[] = ['new', 'triaged', 'assessed', 'mitigated', 'scheduled'];

function clone(row: ReportRow): ReportRow {
  return { ...row, storm_sensitivity: [...row.storm_sensitivity], score_terms: { ...row.score_terms }, flags: { ...row.flags }, photos: row.photos.map((p) => ({ ...p })), events: row.events.map((e) => ({ ...e })) };
}

const byNewest = (a: ReportRow, b: ReportRow) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);
const byScore = (a: ReportRow, b: ReportRow) => b.score - a.score || byNewest(a, b);

export class MemoryReportsRepo implements ReportsRepo {
  readonly rows: ReportRow[] = [];
  private seq = 0;

  constructor(private readonly users: UsersRepo) {}

  async create(input: CreateReportInput, ctx: CreateReportCtx): Promise<CreateReportResult> {
    const existing = this.rows.find((r) => r.client_draft_id === input.clientDraftId);
    if (existing) return { row: clone(existing), created: false };
    const n = ++this.seq;
    const id = `rc_${String(n).padStart(6, '0')}`;
    const duplicates = await this.findDuplicates(input.lat, input.lng, input.subtype);
    const derived = deriveReportFields(input, id, ctx);
    const reporter = derived.reporter_id ? await this.users.getById(derived.reporter_id) : null;
    const row: ReportRow = {
      ...derived,
      tenant_id: MEMORY_TENANT_ID,
      reporter_display_name: reporter?.display_name ?? null,
      cluster_candidate: duplicates[0]?.id ?? null,
      photos: [],
      events: [{ id: `ev_${String(n).padStart(6, '0')}`, kind: 'created', actor_type: 'resident', actor_id: derived.reporter_id, from_status: null, to_status: 'new', note: input.note?.trim() || null, created_at: ctx.now }],
      comment_count: 0,
    };
    this.rows.push(row);
    return { row: clone(row), created: true };
  }

  async getPublicById(id: string): Promise<ReportRow | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? clone(row) : null;
  }

  async listPublic(q: ListPublicQuery): Promise<ListPublicResult> {
    const list = this.rows
      .filter((r) => !q.bbox || inBBox({ lat: r.public_lat, lng: r.public_lng }, q.bbox))
      .filter((r) => !q.category || r.category === q.category)
      .filter((r) => !q.status || r.status === q.status)
      .sort(q.sort === 'newest' ? byNewest : byScore);
    const start = q.cursor ? list.findIndex((r) => r.id === q.cursor) + 1 : 0;
    const page = list.slice(start, start + q.limit);
    const nextCursor = start + q.limit < list.length && page.length > 0 ? page[page.length - 1].id : null;
    return { rows: page.map((r) => ({ ...clone(r), events: [] })), nextCursor };
  }

  async findDuplicates(lat: number, lng: number, subtype: Subtype): Promise<DuplicateCandidate[]> {
    const radius = dupRadiusM(subtype);
    const category = subtypeDef(subtype).category;
    return this.rows
      .filter((r) => r.category === category && OPEN_STATUSES.includes(r.status))
      .map((r) => ({ id: r.id, subtype: r.subtype, status: r.status, distance_m: distanceM({ lat, lng }, { lat: r.lat, lng: r.lng }) }))
      .filter((d) => d.distance_m <= radius)
      .sort((a, b) => a.distance_m - b.distance_m);
  }
}
