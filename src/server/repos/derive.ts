/**
 * Fields the server derives at insert from a validated CreateReportInput, shared by the memory and Supabase repos
 * (plan §4 request flow 2): identity choice → reporter link (plan §3.4), public point via geo.publicPoint (spec §13),
 * storm sensitivity and ADA flag from the taxonomy, emergency = the resident's band 4 answer, and the intake score
 * from domain/score.computeScore() with the inputs known at intake. The resident's note is not derived here: the
 * repos store it as the note of the `created` report_event (plan §6 has no description column on report).
 * Server-only module.
 */
import { publicPoint } from '@/domain/geo';
import { DEFAULT_WEIGHTS, communityTerm, computeScore, scoreFromTerms } from '@/domain/score';
import { subtypeDef } from '@/domain/taxonomy';
import type { CreateReportInput, ScoreTerms } from '@/domain/types';

import type { CreateReportCtx, ReportRow } from './types';

/** Fallback for a stored row whose score_terms column is NULL (never written by this code; defensive). */
export const ZERO_TERMS: ScoreTerms = { severity: 0, exposure: 0, community: 0, liability: 0, decay: 0 };

/**
 * Score after Σ vote weight changed (a photo added to an existing report counts as a vote, plan §4 flow 4): only the
 * community term moves; the stored exposure, liability and decay terms stand until the nightly recompute.
 */
export function rescoreForVotes(row: Pick<ReportRow, 'score_terms' | 'storm_multiplier'>, voteWeightSum: number): { score: number; terms: ScoreTerms } {
  // TODO(M1): block_group_stats.active_users; the floor applies until then (same as deriveReportFields).
  const terms: ScoreTerms = { ...row.score_terms, community: communityTerm(voteWeightSum, 0) };
  return { score: scoreFromTerms(terms, DEFAULT_WEIGHTS, row.storm_multiplier), terms };
}

export type DerivedReportFields = Omit<ReportRow, 'tenant_id' | 'reporter_display_name' | 'cluster_candidate' | 'photos' | 'events' | 'comment_count'>;

export function deriveReportFields(input: CreateReportInput, id: string, ctx: CreateReportCtx): DerivedReportFields {
  const def = subtypeDef(input.subtype);
  const anonymous = input.reporterDisplay === 'anonymous';
  const point = publicPoint({ lat: input.lat, lng: input.lng }, id, !anonymous);
  const reporterVoteWeight = 1; // TODO(M1): domain/votes voteWeight({accountAgeDays, hasHomeArea}) once watch areas reach the users repo
  const scored = computeScore({
    severity: { confirmed: null, ai: null, resident: input.severityResident },
    // TODO(M1): pedsPerDay and exposure flags from the bundled OSM lookup (plan §8 "Exposure data"); 0 until then, recomputed nightly.
    pedsPerDay: 0,
    voteWeightSum: reporterVoteWeight,
    // TODO(M1): block_group_stats.active_users; the floor applies until then.
    activeUsers: 0,
    adaFlag: def.adaRelevant,
    injuryFlag: input.injuryFlag,
    daysOpen: 0,
    stormMultiplier: 1,
  });
  return {
    id,
    client_draft_id: input.clientDraftId,
    reporter_id: anonymous ? null : ctx.userId,
    reporter_display: input.reporterDisplay,
    category: input.category,
    subtype: input.subtype,
    status: 'new',
    severity_resident: input.severityResident,
    severity_ai: null,
    severity_confirmed: null,
    emergency_requested: input.severityResident === 4, // spec: types.ts band 4 = "Emergency"
    injury_flag: input.injuryFlag,
    ada_flag: def.adaRelevant,
    storm_sensitivity: [...def.sensitivity],
    lat: input.lat,
    lng: input.lng,
    public_lat: point.lat,
    public_lng: point.lng,
    // TODO(M1): snap to the nearest bundled address point (plan §4 flow 2); until then the resident's text or nothing.
    address_text: input.addressText?.trim() ?? '',
    address_confidence: input.addressText?.trim() ? 'exact' : 'approx',
    score: scored.score,
    score_terms: scored.terms,
    storm_multiplier: scored.stormMultiplier,
    vote_count: 1, // the reporter's own vote (plan §4 flow 2)
    reporter_vote_weight: reporterVoteWeight,
    flags: {},
    created_at: ctx.now,
    updated_at: ctx.now,
  };
}
