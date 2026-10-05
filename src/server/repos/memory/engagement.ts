/**
 * In-memory EngagementRepo for route tests and the dev server (plan §14 "every +api.ts against repos/memory/*").
 * Vote, follow, comment and flag rows live in this instance; the report counters and timeline are written straight
 * into the MemoryReportsRepo rows they belong to, so a vote changes what GET /api/v1/reports/:id returns, exactly as
 * the database does. Deterministic ids (cm_000001, cf_000001, ev_e00001). Account context (home point, quiet hours)
 * and devices are seeded by tests because MemoryUsersRepo carries no such columns. Server-only module.
 */
import type { LatLng } from '@/domain/geo';

import type { CommentInsert, CommentRow, DeviceRow, EngagementRepo, EventInput, FlagInsert, FlagRow, FollowRow, ReportCounters, UserContext, VoteRow } from '../engagement';
import type { MemoryReportsRepo } from './reports';
import type { MemoryUsersRepo } from './users';

export interface MemoryUserContextSeed {
  home?: LatLng | null;
  quiet_hours?: { start: string; end: string } | null;
}

const pad = (n: number) => String(n).padStart(6, '0');

export class MemoryEngagementRepo implements EngagementRepo {
  readonly votes: VoteRow[] = [];
  readonly follows: FollowRow[] = [];
  readonly comments: CommentRow[] = [];
  readonly flags: FlagRow[] = [];
  readonly devices: DeviceRow[] = [];
  private readonly context = new Map<string, Required<MemoryUserContextSeed>>();
  private seq = 0;

  constructor(
    private readonly users: MemoryUsersRepo,
    private readonly reports: MemoryReportsRepo,
  ) {}

  // ---------- test seeds ----------

  seedContext(userId: string, seed: MemoryUserContextSeed): void {
    const prev = this.context.get(userId) ?? { home: null, quiet_hours: null };
    this.context.set(userId, { home: seed.home === undefined ? prev.home : seed.home, quiet_hours: seed.quiet_hours === undefined ? prev.quiet_hours : seed.quiet_hours });
  }

  seedDevice(device: DeviceRow): void {
    this.devices.push({ ...device });
  }

  // ---------- votes ----------

  async addVote(row: VoteRow): Promise<boolean> {
    if (this.votes.some((v) => v.report_id === row.report_id && v.user_id === row.user_id)) return false;
    this.votes.push({ ...row });
    return true;
  }

  async removeVote(reportId: string, userId: string): Promise<boolean> {
    const i = this.votes.findIndex((v) => v.report_id === reportId && v.user_id === userId);
    if (i < 0) return false;
    this.votes.splice(i, 1);
    return true;
  }

  async voteWeightSum(reportId: string): Promise<number> {
    const row = this.reports.rows.find((r) => r.id === reportId);
    // The reporter's own vote is a report_vote row for Named/Initials (MemoryReportsRepo writes none, so it is
    // reporter_vote_weight here either way) — the production repo sums rows + reporter_vote_weight + orphan_vote_weight.
    const own = row ? row.reporter_vote_weight : 0;
    return this.votes.filter((v) => v.report_id === reportId).reduce((sum, v) => sum + v.weight, own);
  }

  // ---------- counters and timeline ----------

  async updateCounters(reportId: string, c: ReportCounters): Promise<void> {
    const row = this.reports.rows.find((r) => r.id === reportId);
    if (!row) return;
    row.vote_count = c.vote_count;
    row.score = c.score;
    row.score_terms = { ...c.score_terms };
    row.flags = { ...c.flags };
    row.updated_at = c.updated_at;
  }

  async appendEvent(reportId: string, e: EventInput): Promise<void> {
    const row = this.reports.rows.find((r) => r.id === reportId);
    if (!row) return;
    row.events.push({ id: `ev_e${String(++this.seq).padStart(5, '0')}`, ...e });
  }

  // ---------- follows ----------

  async follow(reportId: string, userId: string, now: string): Promise<boolean> {
    if (this.follows.some((f) => f.report_id === reportId && f.user_id === userId)) return false;
    this.follows.push({ report_id: reportId, user_id: userId, created_at: now });
    return true;
  }

  async unfollow(reportId: string, userId: string): Promise<boolean> {
    const i = this.follows.findIndex((f) => f.report_id === reportId && f.user_id === userId);
    if (i < 0) return false;
    this.follows.splice(i, 1);
    return true;
  }

  async followerIds(reportId: string): Promise<string[]> {
    return this.follows.filter((f) => f.report_id === reportId).map((f) => f.user_id);
  }

  // ---------- comments ----------

  async addComment(input: CommentInsert): Promise<CommentRow> {
    const author = input.user_id ? await this.users.getById(input.user_id) : null;
    const row: CommentRow = { id: `cm_${pad(++this.seq)}`, author_display_name: author?.display_name ?? null, ...input };
    this.comments.push(row);
    const report = this.reports.rows.find((r) => r.id === row.report_id);
    if (report && !row.is_internal && !row.hidden) report.comment_count += 1;
    return { ...row };
  }

  async getComment(id: string): Promise<CommentRow | null> {
    const row = this.comments.find((c) => c.id === id);
    return row ? { ...row } : null;
  }

  async listComments(reportId: string, opts: { includeInternal: boolean }): Promise<CommentRow[]> {
    return this.comments
      .filter((c) => c.report_id === reportId && !c.hidden && (opts.includeInternal || !c.is_internal))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .map((c) => ({ ...c }));
  }

  // ---------- flags ----------

  async addFlag(input: FlagInsert): Promise<FlagRow> {
    const row: FlagRow = { id: `cf_${pad(++this.seq)}`, status: 'open', ...input };
    this.flags.push(row);
    return { ...row };
  }

  // ---------- accounts and devices ----------

  async userContext(userId: string): Promise<UserContext | null> {
    const user = await this.users.getById(userId);
    if (!user) return null;
    const ctx = this.context.get(userId);
    return { id: user.id, created_at: user.created_at, home: ctx?.home ?? null, quiet_hours: ctx?.quiet_hours ?? null };
  }

  async devicesFor(userIds: readonly string[]): Promise<DeviceRow[]> {
    const wanted = new Set(userIds);
    return this.devices.filter((d) => wanted.has(d.user_id)).map((d) => ({ ...d }));
  }
}
