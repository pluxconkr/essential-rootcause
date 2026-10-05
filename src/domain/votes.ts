/**
 * Urgency votes — weights, geo check, thresholds and anomaly flags (spec §4.3 lines 2250–2257, §7 line 2361,
 * §13 line 2494; plan §1.3, §12 "Abuse"). Pure module: no React Native or Expo imports. The server applies
 * these on POST /reports/:id/votes (one vote per account per report is the DB primary key); the phone uses the
 * thresholds for the 25-vote meter.
 */
import { distanceM, type LatLng } from './geo';

export const VOTE_THRESHOLDS = {
  supervisorReview: 25, // spec: §4.3 line 2257
  councilItem: 100, // spec: §4.3 line 2257
} as const;

/** Home / watch area must be within this distance of the report, else the vote counts but is flagged. */
export const GEO_RADIUS_M = 1500; // spec: §4.3 line 2253

export const NEW_ACCOUNT_DAYS = 7; // plan §1.3 — accounts younger than this carry the reduced weight

export const VOTE_WEIGHT = {
  reduced: 0.6, // spec: §7 line 2361 — low end of the trust factor range 0.6..1.3; plan §1.3
  full: 1.0, // plan §1.3 — v1 has no earned trust above 1.0
} as const;

/** Weight applied once a vote carries an anomaly flag, pending staff review. */
export const SUSPICIOUS_WEIGHT = 0.5; // plan §12 "anomaly flags → suspicious (weight 0.5, staff review)"

/** Pilot defaults — spec §13 line 2494 names the signals (velocity per device, many accounts per device, distance), not the numbers. */
export const ANOMALY = {
  votesPerHourPerInstall: 20,
  accountsPerInstall: 3,
  farAwayM: 50_000,
} as const;

export const ANOMALY_FLAGS = ['velocity', 'shared_install', 'far_away'] as const;
export type AnomalyFlag = (typeof ANOMALY_FLAGS)[number];

/** 0.6 for accounts younger than 7 days or without a home watch area, 1.0 otherwise (plan §1.3). */
export function voteWeight(account: { accountAgeDays: number; hasHomeArea: boolean }): number {
  const young = !Number.isFinite(account.accountAgeDays) || account.accountAgeDays < NEW_ACCOUNT_DAYS;
  return young || !account.hasHomeArea ? VOTE_WEIGHT.reduced : VOTE_WEIGHT.full;
}

/** Accepted either way; `unverifiedGeo` when there is no home/watch point or it is farther than 1.5 km. */
export function geoCheck(voterPoint: LatLng | null, reportPoint: LatLng): { unverifiedGeo: boolean; distanceM: number | null } {
  if (!voterPoint) return { unverifiedGeo: true, distanceM: null };
  const d = distanceM(voterPoint, reportPoint);
  return { unverifiedGeo: d > GEO_RADIUS_M, distanceM: d };
}

export function anomalyFlags(signals: { votesLastHourByInstall: number; accountsPerInstall: number; distanceM: number | null }): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];
  if (signals.votesLastHourByInstall > ANOMALY.votesPerHourPerInstall) flags.push('velocity');
  if (signals.accountsPerInstall > ANOMALY.accountsPerInstall) flags.push('shared_install');
  if (signals.distanceM != null && signals.distanceM > ANOMALY.farAwayM) flags.push('far_away');
  return flags;
}

/** Threshold flags from the raw vote count (report.flags supervisor_review / council_item). */
export function thresholdFlags(voteCount: number): { supervisorReview: boolean; councilItem: boolean } {
  return { supervisorReview: voteCount >= VOTE_THRESHOLDS.supervisorReview, councilItem: voteCount >= VOTE_THRESHOLDS.councilItem };
}
