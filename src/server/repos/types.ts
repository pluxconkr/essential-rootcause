/**
 * Repository contracts for the API routes (plan §3.1 "injectable repos", §3.10 "getRepos() fails closed with 503").
 * Rows are server-side shapes in snake_case mirroring the SQL columns of plan §6; nothing here reaches a client
 * without passing through src/server/public.ts. Two implementations: repos/supabase (production, service role) and
 * repos/memory (tests and local dev, deterministic). Server-only module.
 */
import type { BBox } from '@/domain/geo';
import type { StormSensitivity } from '@/domain/taxonomy';
import type { Category, CreateReportInput, InjuryFlag, PhotoPhase, ReporterDisplay, ReportStatus, Role, ScoreTerms, SeverityBand, Subtype } from '@/domain/types';

import { getServiceClient } from '../db';
import { createSupabaseRepos } from './supabase';

// ---------- Users ----------

export type AuthProvider = 'apple' | 'google' | 'email';

/** app_user, the columns the routes need. home_geom and phone_e164 stay in the database (plan §6). */
export interface UserRow {
  id: string;
  tenant_id: string;
  role: Role;
  display_name: string | null;
  auth_provider: AuthProvider | null;
  created_at: string;
}

export interface AuthProfile {
  id: string;
  displayName: string | null;
  provider: AuthProvider | null;
  /** From the token, for the dev-memory staff grant only (ROOTCAUSE_DEV_STAFF); never stored by the Supabase repo. */
  email?: string | null;
}

export interface UsersRepo {
  getById(id: string): Promise<UserRow | null>;
  /** Creates the resident row when the auth.users trigger has not (or not yet); returns the row either way. */
  upsertFromAuth(profile: AuthProfile): Promise<UserRow>;
}

// ---------- Reports ----------

export interface ReportPhotoRow {
  id: string;
  phase: PhotoPhase;
  /** staff_only until an inspector releases the photo at triage (plan §12). */
  visibility: 'staff_only' | 'public';
  /** NULL once attached to an anonymous report (plan §3.4). Never public. */
  uploader_id: string | null;
  /** Signed URLs (1 h) resolved by the repo; the memory repo uses placeholders. */
  url: string;
  thumb_url: string;
}

export interface ReportEventRow {
  id: string;
  kind: string;
  actor_type: 'resident' | 'staff' | 'system';
  actor_id: string | null;
  from_status: ReportStatus | null;
  to_status: ReportStatus | null;
  note: string | null;
  created_at: string;
}

/**
 * report (plan §6) plus the joined pieces a projection needs. `lat/lng` are the precise point — staff only. The
 * resident's intake note is the `created` event's note (plan §6 has no description column on report).
 */
export interface ReportRow {
  id: string;
  tenant_id: string;
  client_draft_id: string;
  /** NULL for reports filed as Anonymous (plan §3.4). */
  reporter_id: string | null;
  reporter_display: ReporterDisplay;
  /** app_user.display_name of the reporter, joined; null for anonymous reports. */
  reporter_display_name: string | null;
  category: Category;
  subtype: Subtype;
  status: ReportStatus;
  severity_resident: SeverityBand | null;
  severity_ai: SeverityBand | null;
  severity_confirmed: SeverityBand | null;
  emergency_requested: boolean;
  injury_flag: InjuryFlag;
  ada_flag: boolean;
  storm_sensitivity: StormSensitivity[];
  lat: number;
  lng: number;
  /** geom_public: jittered for reporter-linked reports, precise for anonymous ones until day 30 (spec §12/§13). */
  public_lat: number;
  public_lng: number;
  address_text: string;
  address_confidence: 'exact' | 'approx';
  score: number;
  score_terms: ScoreTerms;
  storm_multiplier: number;
  vote_count: number;
  reporter_vote_weight: number;
  cluster_candidate: string | null;
  flags: Record<string, boolean>;
  created_at: string;
  updated_at: string;
  photos: ReportPhotoRow[];
  events: ReportEventRow[];
  /** Visible, non-internal comments. */
  comment_count: number;
}

export interface CreateReportCtx {
  userId: string;
  role: Role;
  /** Server time as ISO; injected so the memory repo is deterministic. */
  now: string;
  requestId: string;
}

export interface CreateReportResult {
  row: ReportRow;
  /** false when the clientDraftId was already stored: the route answers 200 with the original (plan §4 flow 3). */
  created: boolean;
}

export type ReportSort = 'score' | 'newest';

export interface ListPublicQuery {
  bbox: BBox | null;
  category: Category | null;
  status: ReportStatus | null;
  sort: ReportSort;
  /** Opaque: the id of the last row of the previous page. */
  cursor: string | null;
  limit: number;
}

export interface ListPublicResult {
  rows: ReportRow[];
  nextCursor: string | null;
}

export interface DuplicateCandidate {
  id: string;
  subtype: Subtype;
  status: ReportStatus;
  distance_m: number;
}

export interface ReportsRepo {
  /** Idempotent on input.clientDraftId (unique column): a replay returns the stored row with created=false. */
  create(input: CreateReportInput, ctx: CreateReportCtx): Promise<CreateReportResult>;
  /** Full row with photos, events and counts; the route projects it with toPublicReport(). */
  getPublicById(id: string): Promise<ReportRow | null>;
  /** Rows without timelines (lists carry thumbnails only, plan §3.2). */
  listPublic(query: ListPublicQuery): Promise<ListPublicResult>;
  /** Open reports of the same category within dupRadiusM(subtype) (plan §6 find_duplicates). */
  findDuplicates(lat: number, lng: number, subtype: Subtype): Promise<DuplicateCandidate[]>;
}

// ---------- Health / jobs ----------

export interface HealthRepo {
  /** A real query (the Free-plan keep-alive, plan §3.2). */
  ping(): Promise<{ ok: boolean; latencyMs: number }>;
  usage(): Promise<{ dbBytes: number | null; storageBytes: number | null }>;
}

export interface JobsRepo {
  /** job name → last_ok_at ISO (null when the job never succeeded). */
  lastOkByName(): Promise<Record<string, string | null>>;
}

// ---------- Bundle ----------

export interface Repos {
  users: UsersRepo;
  reports: ReportsRepo;
  health: HealthRepo;
  jobs: JobsRepo;
}

let override: Repos | null = null;

/**
 * Local development without a Supabase project: `ROOTCAUSE_DEV_MEMORY=1 npx expo start` serves the API from the in-memory
 * repos (empty until you create reports; nothing persists across restarts). Refused outside development builds.
 * The bundle hangs off globalThis, not a module variable: the Expo dev server bundles every `+api.ts` route
 * separately, so a module-level singleton would give each route its own empty store and a photo uploaded through
 * one route would be unknown to the next.
 */
const DEV_REPOS_KEY = '__rootcauseDevMemoryRepos';

function devMemoryRepos(): Repos | null {
  if (process.env.ROOTCAUSE_DEV_MEMORY !== '1' || process.env.NODE_ENV === 'production') return null;
  const g = globalThis as unknown as Record<string, Repos | undefined>;
  if (!g[DEV_REPOS_KEY]) {
    // Lazy: repos/memory imports this module, so a static import would be a cycle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const memory = require('./memory') as typeof import('./memory');
    g[DEV_REPOS_KEY] = memory.createMemoryRepos();
  }
  return g[DEV_REPOS_KEY] ?? null;
}

/** Production repos, the test override, or (development only, opt-in) the in-memory repos. Throws ConfigError when the Supabase env is missing — the route answers 503. */
export function getRepos(): Repos {
  if (override) return override;
  const dev = devMemoryRepos();
  if (dev) return dev;
  return createSupabaseRepos(getServiceClient());
}

/** Tests inject memory repos; null restores the Supabase implementation. */
export function setRepos(repos: Repos | null): void {
  override = repos;
}
