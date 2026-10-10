/**
 * Lifecycle repository contract (plan §6 report status columns, report_event, verification, severity_audit; §7
 * PATCH /reports/:id and POST /reports/:id/verify; spec §4.4). Everything a status change or a resident verdict
 * writes, and the tallies the verdict rules read — the verdict reads take `since`, the latest completion's
 * created_at, so verdicts on a fix that was rejected since do not count. Rows are server-side snake_case shapes;
 * nothing here reaches a client without toPublicReport(). Two implementations: repos/supabase/lifecycle
 * (production, service role) and repos/memory/lifecycle (tests and the dev server, sharing rows with
 * createMemoryRepos()). getLifecycleRepo() follows getEngagementRepo(): the test override first, then the bundle
 * getRepos() returns when it carries its own lifecycle repo (ROOTCAUSE_DEV_MEMORY=1, repos/types.ts), else the
 * Supabase implementation — which throws ConfigError without the Supabase env so the route answers 503 (plan
 * §3.10). Server-only module.
 */
import type { ReportStatus, ScoreTerms, SeverityBand } from '@/domain/types';

import { getServiceClient } from '../db';
import type { EventInput } from './engagement';
import { SupabaseLifecycleRepo } from './supabase/lifecycle';
import { getRepos, type Repos } from './types';

export type Verdict = 'confirmed' | 'rejected';

/** The report columns a status move writes. The severity trio travels together so the score stays explainable (plan §8). */
export interface StatusPatch {
  status: ReportStatus;
  updated_at: string;
  severity_confirmed?: SeverityBand;
  score?: number;
  score_terms?: ScoreTerms;
}

/** verification (plan §6): one row per account per completion cycle, enforced by getVerdictByUser() before the insert. */
export interface VerificationRow {
  id: string;
  report_id: string;
  /** NULL after DELETE /me de-identification (plan §12). */
  user_id: string | null;
  verdict: Verdict;
  /** The resident's photo of the hazard — only a rejection with one reopens (spec §4.4 line 2264). */
  photo_id: string | null;
  created_at: string;
}

export type VerificationInsert = Omit<VerificationRow, 'id'>;

export interface VerdictTally {
  confirmations: number;
  rejections: number;
  /** Rejections that carried a photo: the count the reopen rule reads (domain/status REOPEN_REJECTIONS). */
  rejectionsWithPhoto: number;
}

/** severity_audit (plan §6, append-only): every human change of the effective band and why. */
export interface SeverityAuditInsert {
  report_id: string;
  ai_value: SeverityBand | null;
  human_value: SeverityBand;
  /** NULL for a system move (the verification reopen) or a script. */
  inspector_id: string | null;
  reason: string;
  created_at: string;
}

export interface LifecycleRepo {
  // ---------- report ----------
  setStatus(reportId: string, patch: StatusPatch): Promise<void>;
  appendEvent(reportId: string, event: EventInput): Promise<void>;
  appendSeverityAudit(row: SeverityAuditInsert): Promise<void>;

  // ---------- verification ----------
  addVerification(row: VerificationInsert): Promise<VerificationRow>;
  /** This account's verdict at or after `since` (ISO: the current completion's created_at), else null. */
  getVerdictByUser(reportId: string, userId: string, since: string): Promise<VerificationRow | null>;
  /** The tallies of the rows at or after `since` (ISO: the current completion's created_at). */
  countVerdicts(reportId: string, since: string): Promise<VerdictTally>;
}

/** Bundles that also carry a lifecycle repo (repos/memory does; the Supabase one is built from the service client). */
export type ReposWithLifecycle = Repos & { lifecycle: LifecycleRepo };

let override: LifecycleRepo | null = null;

/** The test override, the active bundle's own repo (memory), or the production repo over the service client. Throws ConfigError when the env is missing — the route answers 503. */
export function getLifecycleRepo(): LifecycleRepo {
  if (override) return override;
  const bundle = getRepos() as Partial<ReposWithLifecycle>;
  if (bundle.lifecycle) return bundle.lifecycle;
  return new SupabaseLifecycleRepo(getServiceClient());
}

/** Tests inject the memory repo; null restores the lookup above. */
export function setLifecycleRepo(repo: LifecycleRepo | null): void {
  override = repo;
}
