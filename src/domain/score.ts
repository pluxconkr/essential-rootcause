/**
 * Priority score — one formula, five terms, published to residents and staff (spec §7 lines 2346–2363;
 * plan §8 row score.ts). Pure module: no React Native or Expo imports. The same code runs on the phone
 * (S-07 breakdown, /why/score), in the console (O3 "why it ranks here") and on the server (recompute job),
 * so a score never differs by surface. Test oracles are derived from the formula, not from the prototype's
 * placeholder figures (spec line 2567). Worked example: terms .78/.82/.12/.90/.04 → 60.
 */
import type { StormSensitivity } from './taxonomy';
import type { InjuryFlag, ScoreTerms, ScoreWeights, SeverityBand } from './types';

/** Term weights; tenant-configurable (director, audited), these are the pilot defaults. */
export const DEFAULT_WEIGHTS = {
  severity: 0.32, // spec: §7 line 2349
  exposure: 0.24, // spec: §7 line 2350
  community: 0.22, // spec: §7 line 2351 — capped here so an organised block cannot dominate the queue
  liability: 0.14, // spec: §7 line 2352
  decay: 0.08, // spec: §7 line 2353
} as const satisfies ScoreWeights;

/** Severity band → 0..1 term. */
export const SEVERITY_BAND = { 1: 0.25, 2: 0.5, 3: 0.78, 4: 1 } as const satisfies Record<SeverityBand, number>; // spec: §7 line 2356

/** Band used when no human has answered "how dangerous?" (Open311 inbound, inspection tasks). */
export const UNRATED_BAND: SeverityBand = 2; // plan §8 — labelled "unrated — awaiting triage"
export const UNRATED_LABEL = 'unrated — awaiting triage'; // plan §8

/** Pedestrians per day at which the exposure term saturates. */
export const EXPOSURE_PEDS_REF = 5000; // spec: §7 line 2357

/** Vulnerable-population multiplier on exposure. adaRoute stays 0 in v1 (no ADA route layer yet, plan §8). */
export const VULN_MULT = {
  schoolRoute: 0.15, // spec: §7 line 2358
  seniorFacility: 0.15, // spec: §7 line 2358
  transitStop: 0.1, // spec: §7 line 2359
  adaRoute: 0.1, // spec: §7 line 2359
  cap: 1.4, // spec: §7 line 2359
} as const;

/** Community term: per-capita normalised, log-saturating vote signal. k and the floor are pilot defaults. */
export const COMMUNITY_K = 0.25; // spec: §7 line 2360 names k; value from plan §6 tenant.community_k
export const ACTIVE_USERS_FLOOR = 20; // plan §6 tenant.active_users_floor — two votes must not saturate a tiny block group

export const LIABILITY = {
  ada: 0.9, // spec: §7 line 2362
  injury: 1.0, // spec: §7 line 2362
  nearMiss: 0.5, // plan §8 — pilot default, the spec gives no near-miss weight
  priorNotice: 0.7, // spec: §7 line 2362
  priorNoticeDays: 90, // spec: §7 line 2362
} as const;

export const DECAY_DAYS = 365; // spec: §7 line 2363

/** The storm multiplier applies only while a matching scenario is active. */
export const STORM_MULTIPLIER_RANGE = { min: 1, max: 1.6 } as const; // spec: §7 line 2354

/** Bar labels (spec R6 lines 830–834) and what each term measures (spec §7 comments, lines 2349–2353). */
export const TERM_LABEL = {
  severity: 'Severity', // spec R6 says "AI severity"; the inspector's confirmation replaces the AI estimate, so the label stays honest after triage
  exposure: 'Exposure',
  community: 'Community votes',
  liability: 'Liability / ADA',
  decay: 'Decay (age)',
} as const satisfies Record<keyof ScoreTerms, string>;

export const TERM_MEANING = {
  severity: 'How dangerous the defect is — AI estimate until an inspector confirms it', // spec: §7 line 2349
  exposure: 'How many people pass it each day, weighted for schools, seniors and transit', // spec: §7 line 2350
  community: 'Resident urgency votes, scaled by active users nearby and saturating', // spec: §7 line 2351
  liability: 'ADA threshold, injuries reported and how long the city has known', // spec: §7 line 2352
  decay: 'Age since first report, so nothing rots forever', // spec: §7 line 2353
} as const satisfies Record<keyof ScoreTerms, string>;

export const TERM_KEYS: readonly (keyof ScoreTerms)[] = ['severity', 'exposure', 'community', 'liability', 'decay'];

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export interface SeverityInputs {
  /** Inspector's confirmation or override (writes severity_audit). */
  confirmed: SeverityBand | null;
  /** Vision estimate (flagged route; absent offline or with the flag off). */
  ai: SeverityBand | null;
  /** The resident's "how dangerous right now?" answer. */
  resident: SeverityBand | null;
}

export type SeveritySource = 'confirmed' | 'ai' | 'resident' | 'unrated';

/** Where the effective band came from; `unrated` renders as UNRATED_LABEL. */
export function severitySource(s: SeverityInputs): SeveritySource {
  if (s.confirmed != null) return 'confirmed';
  if (s.ai != null) return 'ai';
  if (s.resident != null) return 'resident';
  return 'unrated';
}

/**
 * confirmed ?? ai ?? (resident != null ? min(resident, 3) : 2). A resident's "Emergency" answer pages the
 * on-call supervisor but scores as band 3 until a human confirms it — band 4 only after human confirmation (plan §8).
 */
export function effectiveSeverity(s: SeverityInputs): SeverityBand {
  if (s.confirmed != null) return s.confirmed;
  // Band 4 is only ever set by a person (plan §8, §23.I): the vision proposal and the resident answer are both capped.
  if (s.ai != null) return s.ai > 3 ? 3 : s.ai;
  if (s.resident != null) return s.resident > 3 ? 3 : s.resident;
  return UNRATED_BAND;
}

export function severityTerm(band: SeverityBand): number {
  return SEVERITY_BAND[band];
}

export interface ExposureFlags {
  schoolRoute?: boolean;
  seniorFacility?: boolean;
  transitStop?: boolean;
  adaRoute?: boolean;
}

/** 1 + 0.15 school + 0.15 senior + 0.10 transit + 0.10 ADA route, capped at 1.4. */
export function vulnMultiplier(flags: ExposureFlags = {}): number {
  const m = 1 + (flags.schoolRoute ? VULN_MULT.schoolRoute : 0) + (flags.seniorFacility ? VULN_MULT.seniorFacility : 0) + (flags.transitStop ? VULN_MULT.transitStop : 0) + (flags.adaRoute ? VULN_MULT.adaRoute : 0);
  return Math.min(VULN_MULT.cap, m);
}

/** min(1, log1p(peds)/log1p(5000)) × vulnMult — the spec applies the multiplier AFTER the min, so the term may reach 1.4 (spec §7 line 2357). */
export const EXPOSURE_TERM_MAX = 1.4;
export function exposureTerm(pedsPerDay: number, flags: ExposureFlags = {}): number {
  const peds = Number.isFinite(pedsPerDay) && pedsPerDay > 0 ? pedsPerDay : 0;
  const base = Math.min(1, Math.log1p(peds) / Math.log1p(EXPOSURE_PEDS_REF));
  return Math.min(EXPOSURE_TERM_MAX, Math.max(0, base * vulnMultiplier(flags)));
}

/** min(1, log1p(Σ vote weight) / log1p(k × max(activeUsers, floor))). Saturates: the 30th vote moves little. */
export function communityTerm(voteWeightSum: number, activeUsers: number, k: number = COMMUNITY_K, floor: number = ACTIVE_USERS_FLOOR): number {
  const sum = Number.isFinite(voteWeightSum) && voteWeightSum > 0 ? voteWeightSum : 0;
  const n = Math.max(Number.isFinite(activeUsers) ? activeUsers : 0, floor);
  const denom = Math.log1p(k * n);
  if (denom <= 0) return sum > 0 ? 1 : 0;
  return clamp01(Math.log1p(sum) / denom);
}

/** max(ada × .9, injury × 1.0, near miss × .5, prior notice > 90 days ? .7 : 0). */
export function liabilityTerm(adaFlag: boolean, injuryFlag: InjuryFlag, priorNoticeDays: number | null = 0): number {
  const injury = injuryFlag === 'injury' ? LIABILITY.injury : injuryFlag === 'near_miss' ? LIABILITY.nearMiss : 0;
  const notice = (priorNoticeDays ?? 0) > LIABILITY.priorNoticeDays ? LIABILITY.priorNotice : 0;
  return Math.max(adaFlag ? LIABILITY.ada : 0, injury, notice);
}

/** min(1, daysOpen / 365). */
export function decayTerm(daysOpen: number): number {
  return clamp01(daysOpen / DECAY_DAYS);
}

/** Clamp a scenario's multiplier into the published 1.0–1.6 range; anything unparsable is 1.0 (no boost). */
export function clampMultiplier(m: number): number {
  return Number.isFinite(m) ? Math.min(STORM_MULTIPLIER_RANGE.max, Math.max(STORM_MULTIPLIER_RANGE.min, m)) : 1;
}

export interface ActiveScenario {
  kind: StormSensitivity;
  multiplier: number;
  /** Window in which the scenario is active (epoch ms, [startsAt, endsAt)). */
  startsAt: number;
  endsAt: number;
}

/**
 * Multiplier timing: 1.0 unless a scenario of a kind this report is sensitive to is active at `now`;
 * then that scenario's multiplier, clamped. The boost ends with the window — the score falls back on its own.
 */
export function stormMultiplierFor(sensitivity: readonly StormSensitivity[], scenario: ActiveScenario | null | undefined, now: number): number {
  if (!scenario) return 1;
  if (now < scenario.startsAt || now >= scenario.endsAt) return 1;
  if (!sensitivity.includes(scenario.kind)) return 1;
  return clampMultiplier(scenario.multiplier);
}

/** 100 × Σ(w · term) × stormMultiplier, rounded to a whole point (60.2 → 60). */
export function scoreFromTerms(terms: ScoreTerms, weights: ScoreWeights = DEFAULT_WEIGHTS, stormMultiplier = 1): number {
  const sum = TERM_KEYS.reduce((acc, key) => acc + weights[key] * terms[key], 0);
  return Math.round(100 * sum * clampMultiplier(stormMultiplier));
}

export interface ScoreInput {
  /** Either the three severity sources or an already-resolved band. */
  severity: SeverityInputs | SeverityBand;
  /** Estimated pedestrians per day at the location (OSM road class lookup in v1, plan §8). */
  pedsPerDay: number;
  exposureFlags?: ExposureFlags;
  /** Σ vote weights incl. the reporter's own (report.reporter_vote_weight for anonymous reports, D13). */
  voteWeightSum: number;
  /** Active users in the block group (block_group_stats). */
  activeUsers: number;
  adaFlag: boolean;
  injuryFlag: InjuryFlag;
  /** Days since the city first had notice of this defect (prior reports, claims, transition-plan items). */
  priorNoticeDays?: number | null;
  daysOpen: number;
  /** Resolved with stormMultiplierFor(); 1 when no scenario is active. */
  stormMultiplier?: number;
  weights?: ScoreWeights;
  communityK?: number;
  activeUsersFloor?: number;
}

export interface ScoreResult {
  score: number;
  terms: ScoreTerms;
  stormMultiplier: number;
}

export function computeScore(input: ScoreInput): ScoreResult {
  const band = typeof input.severity === 'number' ? input.severity : effectiveSeverity(input.severity);
  const terms: ScoreTerms = {
    severity: severityTerm(band),
    exposure: exposureTerm(input.pedsPerDay, input.exposureFlags),
    community: communityTerm(input.voteWeightSum, input.activeUsers, input.communityK, input.activeUsersFloor),
    liability: liabilityTerm(input.adaFlag, input.injuryFlag, input.priorNoticeDays),
    decay: decayTerm(input.daysOpen),
  };
  const stormMultiplier = clampMultiplier(input.stormMultiplier ?? 1);
  return { score: scoreFromTerms(terms, input.weights ?? DEFAULT_WEIGHTS, stormMultiplier), terms, stormMultiplier };
}

export interface ExplainRow {
  key: keyof ScoreTerms;
  label: string;
  meaning: string;
  /** The 0..1 term as scored. */
  term: number;
  weight: number;
  /** Points of 100 this term contributes before the storm multiplier, to one decimal. */
  points: number;
  /** "Exposure: 0.82 × 0.24 = 19.7 pts" — the multiplication the resident can check (T8). */
  text: string;
}

/** Plain-language rows for S-07, O3 and /why/score: every number shows its own multiplication. */
export function explain(terms: ScoreTerms, weights: ScoreWeights = DEFAULT_WEIGHTS): ExplainRow[] {
  return TERM_KEYS.map((key) => {
    const term = clamp01(terms[key]);
    const weight = weights[key];
    const points = Math.round(100 * weight * term * 10) / 10;
    return { key, label: TERM_LABEL[key], meaning: TERM_MEANING[key], term, weight, points, text: `${TERM_LABEL[key]}: ${term.toFixed(2)} × ${weight.toFixed(2)} = ${points.toFixed(1)} pts` };
  });
}
