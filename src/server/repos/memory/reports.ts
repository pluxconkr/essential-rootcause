/**
 * In-memory ReportsRepo for route tests and the dev server: deterministic ids (rc_000001…), the same derivation as
 * production (repos/derive.ts), the duplicate search done with geo.distanceM over dupRadiusM(subtype) (plan §6
 * find_duplicates) and the same cursor semantics as the reports_in_bbox RPC (cursor = id of the last row). State
 * lives in the instance; tests create a fresh one. Server-only module.
 */
import { distanceM, inBBox } from '@/domain/geo';
import { isOpen } from '@/domain/status';
import { dupRadiusM, subtypeDef } from '@/domain/taxonomy';
import type { CreateReportInput, ReportStatus, Subtype } from '@/domain/types';
import { VOTE_WEIGHT } from '@/domain/votes';

import { deriveReportFields, rescoreForVotes } from '../derive';
import type { AttachPhotoCtx, AttachPhotoResult, PhotoAttachingReportsRepo, PhotoRow } from '../photos';
import type { CreateReportCtx, CreateReportResult, DuplicateCandidate, ListPublicQuery, ListPublicResult, ReportEventRow, ReportPhotoRow, ReportRow, ReportsRepo, UsersRepo } from '../types';
import type { MemoryPhotosRepo } from './photos';
import { MEMORY_TENANT_ID } from './users';

/** Statuses a duplicate candidate may have: anything not closed out (plan §6 "open reports"). */
export const OPEN_STATUSES: readonly ReportStatus[] = ['new', 'triaged', 'assessed', 'mitigated', 'scheduled'];

function clone(row: ReportRow): ReportRow {
  return { ...row, storm_sensitivity: [...row.storm_sensitivity], score_terms: { ...row.score_terms }, flags: { ...row.flags }, photos: row.photos.map((p) => ({ ...p })), events: row.events.map((e) => ({ ...e })) };
}

const byNewest = (a: ReportRow, b: ReportRow) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);
const byScore = (a: ReportRow, b: ReportRow) => b.score - a.score || byNewest(a, b);

/** Memory rows have no signed URLs; placeholders keep the shape (staff_only photos never reach a public projection anyway). */
function toReportPhotoRow(p: PhotoRow): ReportPhotoRow {
  return { id: p.id, phase: p.phase, visibility: p.visibility, uploader_id: p.uploader_id, url: `memory://${p.storage_key}`, thumb_url: `memory://${p.thumb_key}` };
}

export class MemoryReportsRepo implements ReportsRepo, PhotoAttachingReportsRepo {
  readonly rows: ReportRow[] = [];
  /** report_vote rows: report id → user id → weight. The reporter's own for Named/Initials; none for Anonymous (plan §3.4). */
  readonly voteRows = new Map<string, Map<string, number>>();
  /** report_follow rows: report id → user ids. The reporter's unless Anonymous (plan §3.4). */
  readonly followRows = new Map<string, Set<string>>();
  private seq = 0;

  constructor(
    private readonly users: UsersRepo,
    private readonly photos?: MemoryPhotosRepo,
  ) {}

  async create(input: CreateReportInput, ctx: CreateReportCtx): Promise<CreateReportResult> {
    const existing = this.rows.find((r) => r.client_draft_id === input.clientDraftId);
    if (existing) return { row: clone(existing), created: false };
    const n = ++this.seq;
    const id = `rc_${String(n).padStart(6, '0')}`;
    const duplicates = await this.findDuplicates(input.lat, input.lng, input.subtype);
    const derived = deriveReportFields(input, id, ctx);
    const anonymous = derived.reporter_id === null;
    const reporter = derived.reporter_id ? await this.users.getById(derived.reporter_id) : null;
    // Pending uploads become this report's photos; an anonymous report drops their uploader link (plan §3.4, §23.D).
    const attached = this.photos ? await this.photos.attach(input.photoIds, { reportId: id, anonymous, phase: 'before' }) : [];
    const row: ReportRow = {
      ...derived,
      tenant_id: MEMORY_TENANT_ID,
      reporter_display_name: reporter?.display_name ?? null,
      cluster_candidate: duplicates[0]?.id ?? null,
      photos: attached.map(toReportPhotoRow),
      events: [
        {
          id: `ev_${String(n).padStart(6, '0')}`,
          kind: 'created',
          // 'reporter_anonymous' + NULL actor is the SQL contract for anonymous creation events (plan §23.D); repos/types.ts does not list the value yet.
          actor_type: (anonymous ? 'reporter_anonymous' : 'resident') as ReportEventRow['actor_type'],
          actor_id: derived.reporter_id,
          from_status: null,
          to_status: 'new',
          note: input.note?.trim() || null,
          created_at: ctx.now,
        },
      ],
      comment_count: 0,
    };
    if (derived.reporter_id) {
      this.voteRows.set(id, new Map([[derived.reporter_id, derived.reporter_vote_weight]]));
      this.followRows.set(id, new Set([derived.reporter_id]));
    }
    this.rows.push(row);
    return { row: clone(row), created: true };
  }

  /** POST /api/v1/reports/[id]/photos: attach a pending photo; `before` also records the attaching account's vote (plan §4 flow 4). */
  async attachPhoto(reportId: string, photo: PhotoRow, ctx: AttachPhotoCtx): Promise<AttachPhotoResult> {
    const row = this.rows.find((r) => r.id === reportId);
    if (!row) return { ok: false, reason: 'not_found' };
    if (ctx.phase === 'before' && !isOpen(row.status)) return { ok: false, reason: 'closed' };
    const attached = this.photos ? await this.photos.attach([photo.id], { reportId, anonymous: false, phase: ctx.phase }) : [{ ...photo, report_id: reportId, phase: ctx.phase }];
    for (const p of attached) row.photos.push(toReportPhotoRow(p));
    let voted = false;
    if (ctx.phase === 'before') {
      const votes = this.voteRows.get(reportId) ?? new Map<string, number>();
      if (!votes.has(ctx.userId)) {
        votes.set(ctx.userId, VOTE_WEIGHT.full); // TODO(M1): domain/votes voteWeight({accountAgeDays, hasHomeArea}) once the users repo exposes them (same as repos/derive.ts)
        this.voteRows.set(reportId, votes);
        row.vote_count += 1;
        // The reporter's own vote is already in reporter_vote_weight (repos/derive.ts); add everyone else's row.
        const others = [...votes].filter(([uid]) => uid !== row.reporter_id).reduce((sum, [, w]) => sum + w, 0);
        const rescored = rescoreForVotes(row, row.reporter_vote_weight + others);
        row.score = rescored.score;
        row.score_terms = rescored.terms;
        voted = true;
      }
    }
    row.updated_at = ctx.now;
    return { ok: true, row: clone(row), voted };
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
