/**
 * Service levels per severity band (spec O10 "SLA performance" table lines 1902–1907; plan §6 sla_config
 * numeric values for the prose cells; plan §7 "SLA state computed at read time"). Pure module: no React Native
 * or Expo imports. Four clocks start at creation: acknowledge, assess, mitigate, permanent fix. Mitigation
 * stops the liability clock (spec line 1910) but the fix clock keeps running; a later stage satisfies the
 * earlier ones, so a report assessed on day 2 counts as acknowledged even if nobody stamped first_ack_at.
 */
import { DAY_MS, toEpoch } from './time';
import type { ReportStatus, SeverityBand, SlaState } from './types';

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

export const SLA_STAGES = ['ack', 'assess', 'mitigate', 'fix'] as const;
export type SlaStage = (typeof SLA_STAGES)[number];

export const SLA_STAGE_LABEL = {
  ack: 'Acknowledge', // spec: O10 table header line 1902
  assess: 'Assess', // spec: O10 table header line 1902
  mitigate: 'Mitigate', // spec: O10 table header line 1902
  fix: 'Permanent fix', // spec: O10 table header line 1902
} as const satisfies Record<SlaStage, string>;

export interface SlaBand {
  ack: number;
  assess: number;
  /** null = no mitigation clock for this band ("—" in the spec table). */
  mitigate: number | null;
  fix: number;
}

/** Milliseconds from creation for each stage, per band. */
export const SLA_CONFIG = {
  4: { ack: 15 * MIN_MS, assess: 2 * HOUR_MS, mitigate: DAY_MS, fix: 30 * DAY_MS }, // spec: O10 line 1904 — Emergency: 15 min / 2 h / same day (24 h) / 30 days
  3: { ack: DAY_MS, assess: 10 * DAY_MS, mitigate: 14 * DAY_MS, fix: 90 * DAY_MS }, // spec: O10 line 1905 — High: 1 day / 10 days / 14 days / 90 days
  2: { ack: 3 * DAY_MS, assess: 30 * DAY_MS, mitigate: null, fix: 120 * DAY_MS }, // spec: O10 line 1906 — Moderate: 3 days / 30 days / — / "1 season" = 120 d (plan §6)
  1: { ack: 5 * DAY_MS, assess: 90 * DAY_MS, mitigate: null, fix: 365 * DAY_MS }, // spec: O10 line 1907 — Low: 5 days / "Next cycle" = 90 d / — / "Bundled" = 365 d (plan §6)
} as const satisfies Record<SeverityBand, SlaBand>;

export type SlaConfig = Record<SeverityBand, SlaBand>;

/** A pending stage is at risk once less than this share of its interval remains. */
export const AT_RISK_FRACTION = 0.2; // pilot default — the spec O10 table and plan §8 name the SLA states, not the at-risk margin

type Stamp = string | number | null | undefined;

export interface SlaReportLike {
  severity: SeverityBand;
  status: ReportStatus;
  createdAt: string | number;
  firstAckAt?: Stamp;
  assessedAt?: Stamp;
  mitigatedAt?: Stamp;
  completedAt?: Stamp;
}

export type SlaStageStatus = SlaState | 'met' | 'skipped';

export interface SlaStageState {
  stage: SlaStage;
  label: string;
  /** Deadline (epoch ms); null when the band has no clock for this stage. */
  due: number | null;
  doneAt: number | null;
  state: SlaStageStatus;
}

const stamp = (v: Stamp): number | null => {
  if (v == null) return null;
  const t = toEpoch(v);
  return t > 0 ? t : null;
};

/** Deadlines for each stage from the creation time (S-07 "what happens next" timeline). */
export function slaDeadlines(createdAt: string | number, severity: SeverityBand, config: SlaConfig = SLA_CONFIG): Record<SlaStage, number | null> {
  const created = toEpoch(createdAt);
  const band = config[severity];
  return { ack: created + band.ack, assess: created + band.assess, mitigate: band.mitigate == null ? null : created + band.mitigate, fix: created + band.fix };
}

/** Per-stage state at `now`. A rejected report owes nothing (all stages skipped). */
export function slaStages(report: SlaReportLike, now: number, config: SlaConfig = SLA_CONFIG): SlaStageState[] {
  const created = toEpoch(report.createdAt);
  const band = config[report.severity];
  const completed = stamp(report.completedAt);
  const mitigated = stamp(report.mitigatedAt) ?? completed;
  const assessed = stamp(report.assessedAt) ?? mitigated;
  const acked = stamp(report.firstAckAt) ?? assessed;
  const done: Record<SlaStage, number | null> = { ack: acked, assess: assessed, mitigate: mitigated, fix: completed };
  const owesNothing = report.status === 'rejected';
  return SLA_STAGES.map((stage) => {
    const interval = band[stage];
    const label = SLA_STAGE_LABEL[stage];
    if (interval == null || owesNothing) return { stage, label, due: interval == null ? null : created + interval, doneAt: done[stage], state: 'skipped' };
    const due = created + interval;
    const doneAt = done[stage];
    let state: SlaStageStatus;
    if (doneAt != null) state = doneAt <= due ? 'met' : 'breached';
    else if (now > due) state = 'breached';
    else if (now >= due - AT_RISK_FRACTION * interval) state = 'at_risk';
    else state = 'on_track';
    return { stage, label, due, doneAt, state };
  });
}

/** breached if any stage is breached, at_risk if any pending stage is within 20 % of its deadline, else on_track. */
export function slaState(report: SlaReportLike, now: number, config: SlaConfig = SLA_CONFIG): SlaState {
  const stages = slaStages(report, now, config);
  if (stages.some((s) => s.state === 'breached')) return 'breached';
  if (stages.some((s) => s.state === 'at_risk')) return 'at_risk';
  return 'on_track';
}

