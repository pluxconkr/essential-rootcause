/**
 * Engagement repository contract (plan §6 report_vote / report_follow / report_comment / content_flag and the report
 * counters; §7 votes, comments, follow and flag routes; §9.4 status push). Rows are server-side snake_case shapes;
 * nothing here reaches a client without a projection in the route. Two implementations: repos/supabase/engagement
 * (production, service role) and repos/memory/engagement (tests and local dev, deterministic). getEngagementRepo()
 * fails closed like getRepos(): a missing Supabase env throws ConfigError and the route answers 503 (plan §3.10).
 * Server-only module.
 */
import type { LatLng } from '@/domain/geo';
import type { ReportStatus, ScoreTerms } from '@/domain/types';

import { getServiceClient } from '../db';
import { SupabaseEngagementRepo } from './supabase/engagement';
import { getRepos } from './types';

/** report_vote: one row per account per report (primary key), weight from domain/votes, geo flag from the 1.5 km check. */
export interface VoteRow {
  report_id: string;
  user_id: string;
  weight: number;
  unverified_geo: boolean;
  /** The phone's x-install-id, kept for the anomaly flags (plan §12); never public, never logged. */
  install_id: string | null;
  created_at: string;
}

export interface FollowRow {
  report_id: string;
  user_id: string;
  created_at: string;
}

/** report_comment plus the author's display name joined from app_user (null after DELETE /me → "Former user"). */
export interface CommentRow {
  id: string;
  report_id: string;
  user_id: string | null;
  author_display_name: string | null;
  body: string;
  is_staff: boolean;
  /** Staff-only note; still subject to records requests (plan §12). Never listed to residents. */
  is_internal: boolean;
  hidden: boolean;
  created_at: string;
}

export type CommentInsert = Omit<CommentRow, 'id' | 'author_display_name'>;

export interface FlagRow {
  id: string;
  target_type: 'report' | 'comment' | 'photo';
  target_id: string;
  reporter_id: string | null;
  /** FlagInput.reason on the first line, the optional note after it. */
  reason: string;
  status: 'open' | 'actioned' | 'dismissed';
  created_at: string;
}

export type FlagInsert = Omit<FlagRow, 'id' | 'status'>;

export interface DeviceRow {
  user_id: string;
  expo_push_token: string;
  platform: 'ios' | 'android' | 'web';
}

/** What a vote and a status push need to know about an account. home never leaves the server (plan §6, §12). */
export interface UserContext {
  id: string;
  created_at: string;
  /** The home watch area's point (plan §3.4 "hasHomeArea"), else app_user.home_geom, else null. */
  home: LatLng | null;
  quiet_hours: { start: string; end: string } | null;
}

/** The report columns a vote changes (plan §4 flow 5). */
export interface ReportCounters {
  vote_count: number;
  score: number;
  score_terms: ScoreTerms;
  flags: Record<string, boolean>;
  updated_at: string;
}

export interface EventInput {
  kind: string;
  actor_type: 'resident' | 'staff' | 'system';
  actor_id: string | null;
  from_status: ReportStatus | null;
  to_status: ReportStatus | null;
  note: string | null;
  created_at: string;
}

export interface EngagementRepo {
  // ---------- votes (report_vote) ----------
  /** false when this account already voted on the report (primary-key conflict → the route answers 409). */
  addVote(row: VoteRow): Promise<boolean>;
  /** true when a row was removed. */
  removeVote(reportId: string, userId: string): Promise<boolean>;
  /** Σ report_vote.weight + report.reporter_vote_weight (anonymous reporters, D13) + report.orphan_vote_weight (deleted accounts, §23.C). */
  voteWeightSum(reportId: string): Promise<number>;

  // ---------- report counters and timeline ----------
  updateCounters(reportId: string, counters: ReportCounters): Promise<void>;
  appendEvent(reportId: string, event: EventInput): Promise<void>;

  // ---------- follows (report_follow) ----------
  /** false when already following (idempotent). */
  follow(reportId: string, userId: string, now: string): Promise<boolean>;
  unfollow(reportId: string, userId: string): Promise<boolean>;
  followerIds(reportId: string): Promise<string[]>;

  // ---------- comments (report_comment) ----------
  addComment(row: CommentInsert): Promise<CommentRow>;
  getComment(id: string): Promise<CommentRow | null>;
  /** Visible (not hidden) comments, oldest first; internal notes only when asked for by a staff route. */
  listComments(reportId: string, opts: { includeInternal: boolean }): Promise<CommentRow[]>;

  // ---------- flags (content_flag) ----------
  addFlag(row: FlagInsert): Promise<FlagRow>;

  // ---------- accounts and devices ----------
  userContext(userId: string): Promise<UserContext | null>;
  devicesFor(userIds: readonly string[]): Promise<DeviceRow[]>;
}

let override: EngagementRepo | null = null;

/** Production repo over the service client, or the test override. Throws ConfigError when the env is missing — the route answers 503. */
export function getEngagementRepo(): EngagementRepo {
  if (override) return override;
  const bundle = getRepos() as Partial<{ engagement: EngagementRepo }>;
  if (bundle.engagement) return bundle.engagement; // the dev-memory server (ROOTCAUSE_DEV_MEMORY=1) carries its own
  return new SupabaseEngagementRepo(getServiceClient());
}

/** Tests inject the memory repo; null restores the Supabase implementation. */
export function setEngagementRepo(repo: EngagementRepo | null): void {
  override = repo;
}
