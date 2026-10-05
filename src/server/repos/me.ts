/**
 * Profile, watch areas, devices, own reports, export and account deletion for the /api/v1/me routes (plan §7 /me
 * rows, §9.3, §12 "Deletion vs retention", §23.C). A repo of its own with its own factory because repos/types.ts is
 * the frozen M0 contract: getMeRepo() follows getRepos() — Supabase in production, a test override, ConfigError
 * (→ 503) when the env is missing. Rows are server-side snake_case shapes; MeProfile (src/domain/types.ts) is the only
 * thing the routes send back, and own reports leave through toPublicReport() like every other report. Server-only module.
 */
import type { DeviceInput, MePatch, ReportStatus, Role, WatchArea, WatchAreaInput } from '@/domain/types';

import { getServiceClient } from '../db';
import { SupabaseMeRepo } from './supabase/me';
import { getRepos, type AuthProvider, type ReportRow } from './types';

/** app_user as the profile needs it (plan §6). phone_e164 and home_geom never leave the database. email comes from auth.users. */
export interface MeRow {
  id: string;
  role: Role;
  display_name: string | null;
  auth_provider: AuthProvider;
  email: string | null;
  phone_verified_at: string | null;
  sms_opt_in: boolean;
  quiet_hours: { start: string; end: string } | null;
  /** Sealed by src/server/apple.ts sealToken(); null until POST /me/apple-link ran. */
  apple_refresh_token: string | null;
  /** Tombstone (plan §23.C): set by deidentify(); the row stays so "former user" attributions resolve. */
  deleted_at: string | null;
  created_at: string;
}

export interface MeStats {
  filed: number;
  resolved: number;
  votes: number;
}

/** Statuses that count as "resolved" in the impact stats (spec R13). */
export const RESOLVED_STATUSES: readonly ReportStatus[] = ['completed', 'verified'];

export interface MeExportData {
  votes: { reportId: string; at: string }[];
  follows: string[];
  comments: { reportId: string; body: string; at: string }[];
  devices: { platform: string; lastSeenAt: string }[];
}

/** Row counts of what deidentify() touched (plan §23.C): logged, never the ids. */
export interface DeidentifyResult {
  reports: number;
  photos: number;
  comments: number;
  votes: number;
  follows: number;
  devices: number;
  watchAreas: number;
  /** Σ weight of the removed votes, now carried by report.orphan_vote_weight. */
  orphanVoteWeight: number;
}

export interface MeRepo {
  getMe(userId: string): Promise<MeRow | null>;
  getStats(userId: string): Promise<MeStats>;
  /** Only the keys present in `patch` change; displayName is stored trimmed, '' as null. */
  patchMe(userId: string, patch: MePatch): Promise<void>;
  listWatchAreas(userId: string): Promise<WatchArea[]>;
  createWatchArea(userId: string, input: WatchAreaInput): Promise<WatchArea>;
  /** null when the area does not exist or belongs to someone else (the route answers 404 either way). */
  updateWatchArea(userId: string, id: string, input: Partial<WatchAreaInput>): Promise<WatchArea | null>;
  deleteWatchArea(userId: string, id: string): Promise<boolean>;
  /** One row per push token; a sign-in on a shared phone moves the token to the new user (plan §6 device). */
  upsertDevice(userId: string, input: DeviceInput, now: string): Promise<void>;
  /** Reports filed as Named or Initials, newest first. Anonymous ones have no reporter_id by design (plan §3.4). */
  listOwnReports(userId: string, limit: number): Promise<ReportRow[]>;
  exportData(userId: string): Promise<MeExportData>;
  setAppleRefreshToken(userId: string, sealed: string | null): Promise<void>;
  /**
   * Plan §23.C / §12 order inside one transaction: votes summed into report.orphan_vote_weight and removed
   * (vote_count unchanged) → reporter_id NULL + display anonymous → photo uploader NULL → comments to "former user"
   * → follows, devices, watch areas removed → app_user tombstone (name, phone, home, quiet hours, Apple token cleared;
   * deleted_at set). Throws on a database error so the route never deletes the auth user over half-finished work.
   */
  deidentify(userId: string, now: string): Promise<DeidentifyResult>;
  /** auth.admin.deleteUser; false when the auth API refused (the route answers 500 and the client retries). */
  deleteAuthUser(userId: string): Promise<boolean>;
}

let override: MeRepo | null = null;

/** Production repo, or the test override. Throws ConfigError when the Supabase env is missing — the route answers 503. */
export function getMeRepo(): MeRepo {
  if (override) return override;
  return new SupabaseMeRepo(getServiceClient(), getRepos());
}

/** Tests inject the memory repo; null restores the Supabase implementation. */
export function setMeRepo(repo: MeRepo | null): void {
  override = repo;
}

/** jsonb → the quiet-hours shape the schemas use, or null for anything else. */
export function quietHoursOf(v: unknown): { start: string; end: string } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { start?: unknown; end?: unknown };
  return typeof o.start === 'string' && typeof o.end === 'string' ? { start: o.start, end: o.end } : null;
}
