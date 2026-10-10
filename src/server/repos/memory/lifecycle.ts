/**
 * In-memory LifecycleRepo for route tests and the dev server (plan §14 "every +api.ts against repos/memory/*").
 * Status, severity and timeline writes land straight in the MemoryReportsRepo rows they belong to, so a status
 * change shows in GET /api/v1/reports/:id exactly as the database does; verification and severity_audit rows live
 * in this instance, and the verdict reads apply `since` as the SQL does (ISO timestamps compare as strings).
 * Deterministic ids (vf_000001, ev_l00001). Server-only module.
 */
import type { EventInput } from '../engagement';
import type { LifecycleRepo, SeverityAuditInsert, StatusPatch, VerdictTally, VerificationInsert, VerificationRow } from '../lifecycle';
import type { MemoryReportsRepo } from './reports';

const pad = (n: number, width: number) => String(n).padStart(width, '0');

export class MemoryLifecycleRepo implements LifecycleRepo {
  readonly verifications: VerificationRow[] = [];
  readonly severityAudits: SeverityAuditInsert[] = [];
  private seq = 0;

  constructor(private readonly reports: MemoryReportsRepo) {}

  // ---------- report ----------

  async setStatus(reportId: string, patch: StatusPatch): Promise<void> {
    const row = this.reports.rows.find((r) => r.id === reportId);
    if (!row) return;
    row.status = patch.status;
    row.updated_at = patch.updated_at;
    if (patch.severity_confirmed !== undefined) row.severity_confirmed = patch.severity_confirmed;
    if (patch.score !== undefined) row.score = patch.score;
    if (patch.score_terms !== undefined) row.score_terms = { ...patch.score_terms };
  }

  async appendEvent(reportId: string, e: EventInput): Promise<void> {
    const row = this.reports.rows.find((r) => r.id === reportId);
    if (!row) return;
    row.events.push({ id: `ev_l${pad(++this.seq, 5)}`, ...e });
  }

  async appendSeverityAudit(row: SeverityAuditInsert): Promise<void> {
    this.severityAudits.push({ ...row });
  }

  // ---------- verification ----------

  async addVerification(input: VerificationInsert): Promise<VerificationRow> {
    const row: VerificationRow = { id: `vf_${pad(++this.seq, 6)}`, ...input };
    this.verifications.push(row);
    return { ...row };
  }

  async getVerdictByUser(reportId: string, userId: string, since: string): Promise<VerificationRow | null> {
    const row = this.verifications.find((v) => v.report_id === reportId && v.user_id === userId && v.created_at >= since);
    return row ? { ...row } : null;
  }

  async countVerdicts(reportId: string, since: string): Promise<VerdictTally> {
    const tally: VerdictTally = { confirmations: 0, rejections: 0, rejectionsWithPhoto: 0 };
    for (const v of this.verifications) {
      if (v.report_id !== reportId || v.created_at < since) continue;
      if (v.verdict === 'confirmed') tally.confirmations += 1;
      else {
        tally.rejections += 1;
        if (v.photo_id) tally.rejectionsWithPhoto += 1;
      }
    }
    return tally;
  }
}
