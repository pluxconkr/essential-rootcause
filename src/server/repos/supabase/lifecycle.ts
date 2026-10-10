/**
 * Supabase LifecycleRepo over report (status, severity, score and the SLA stamps), report_event, verification and
 * severity_audit (plan §6, §7; spec §4.4). One statement per call, no embedded joins. Writes throw on a database
 * error so the route answers 500 and nothing half-applied is reported as done.
 *
 * Column contract with supabase/migrations/0001_init.sql:
 *   - report.status / severity_confirmed / score / score_terms / updated_at, plus the stamp the new status owns
 *     (first_ack_at, assessed_at, mitigated_at, completed_at, verified_at, closed_at) — jobs/autoVerify reads
 *     completed_at and the SLA clock reads the rest; an earlier stamp is left as history when a report reopens;
 *   - report_event (report_id, actor_type, actor_id, from_status, to_status, kind, note, created_at), append-only;
 *   - verification (report_id, user_id, verdict, photo_id, created_at) — no unique key, so the one-verdict rule is
 *     getVerdictByUser() before addVerification(); both reads filter created_at >= `since` (the current completion's
 *     created_at) so a rejected fix's verdicts do not count against the next one;
 *   - severity_audit (report_id, ai_value, human_value, inspector_id, reason, created_at), append-only.
 * Server-only module.
 */
import type { ReportStatus } from '@/domain/types';

import type { ServiceClient } from '../../db';
import type { EventInput } from '../engagement';
import type { LifecycleRepo, SeverityAuditInsert, StatusPatch, VerdictTally, VerificationInsert, VerificationRow } from '../lifecycle';

const VERIFICATION_COLUMNS = 'id, report_id, user_id, verdict, photo_id, created_at';

/** The timestamp column(s) each status owns (plan §6 report; spec §6 data model line 2295). */
const STAMP: Partial<Record<ReportStatus, readonly string[]>> = {
  triaged: ['first_ack_at'],
  assessed: ['assessed_at'],
  mitigated: ['mitigated_at'],
  completed: ['completed_at'],
  verified: ['verified_at', 'closed_at'],
  rejected: ['closed_at'],
};

export class SupabaseLifecycleRepo implements LifecycleRepo {
  constructor(private readonly client: ServiceClient) {}

  // ---------- report ----------

  async setStatus(reportId: string, patch: StatusPatch): Promise<void> {
    const update: Record<string, unknown> = { status: patch.status, updated_at: patch.updated_at };
    for (const column of STAMP[patch.status] ?? []) update[column] = patch.updated_at;
    if (patch.severity_confirmed !== undefined) update.severity_confirmed = patch.severity_confirmed;
    if (patch.score !== undefined) update.score = patch.score;
    if (patch.score_terms !== undefined) update.score_terms = patch.score_terms;
    const { error } = await this.client.from('report').update(update).eq('id', reportId);
    if (error) throw new Error(`report status update failed: ${error.message}`);
  }

  async appendEvent(reportId: string, e: EventInput): Promise<void> {
    const { error } = await this.client.from('report_event').insert({ report_id: reportId, kind: e.kind, actor_type: e.actor_type, actor_id: e.actor_id, from_status: e.from_status, to_status: e.to_status, note: e.note, created_at: e.created_at });
    if (error) throw new Error(`report_event insert failed: ${error.message}`);
  }

  async appendSeverityAudit(row: SeverityAuditInsert): Promise<void> {
    const { error } = await this.client.from('severity_audit').insert({ report_id: row.report_id, ai_value: row.ai_value, human_value: row.human_value, inspector_id: row.inspector_id, reason: row.reason, created_at: row.created_at });
    if (error) throw new Error(`severity_audit insert failed: ${error.message}`);
  }

  // ---------- verification ----------

  async addVerification(input: VerificationInsert): Promise<VerificationRow> {
    const { data, error } = await this.client.from('verification').insert({ report_id: input.report_id, user_id: input.user_id, verdict: input.verdict, photo_id: input.photo_id, created_at: input.created_at }).select(VERIFICATION_COLUMNS).single();
    if (error || !data) throw new Error(`verification insert failed: ${error?.message ?? 'no row'}`);
    return data as unknown as VerificationRow;
  }

  async getVerdictByUser(reportId: string, userId: string, since: string): Promise<VerificationRow | null> {
    const { data, error } = await this.client.from('verification').select(VERIFICATION_COLUMNS).eq('report_id', reportId).eq('user_id', userId).gte('created_at', since).order('created_at', { ascending: true }).limit(1).maybeSingle();
    if (error) throw new Error(`verification read failed: ${error.message}`);
    return data ? (data as unknown as VerificationRow) : null;
  }

  async countVerdicts(reportId: string, since: string): Promise<VerdictTally> {
    const { data, error } = await this.client.from('verification').select('verdict, photo_id').eq('report_id', reportId).gte('created_at', since);
    if (error) throw new Error(`verification tally failed: ${error.message}`);
    const tally: VerdictTally = { confirmations: 0, rejections: 0, rejectionsWithPhoto: 0 };
    for (const v of (data ?? []) as { verdict: string; photo_id: string | null }[]) {
      if (v.verdict === 'confirmed') tally.confirmations += 1;
      else {
        tally.rejections += 1;
        if (v.photo_id) tally.rejectionsWithPhoto += 1;
      }
    }
    return tally;
  }
}
