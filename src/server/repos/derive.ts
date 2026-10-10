/**
 * Fields the server derives at insert from a validated CreateReportInput, shared by the memory and Supabase repos
 * (plan §4 request flow 2): identity choice → reporter link (plan §3.4), public point via geo.publicPoint (spec §13),
 * storm sensitivity and ADA flag from the taxonomy, emergency = the resident's band 4 answer, and the intake score
 * from domain/score.computeScore() with the inputs known at intake. The resident's note is not derived here: the
 * repos store it as the note of the `created` report_event (plan §6 has no description column on report).
 * Server-only module.
 */
import type { ExposureInputs } from '@/domain/exposure';
import { publicPoint } from '@/domain/geo';
import { DEFAULT_WEIGHTS, communityTerm, computeScore, scoreFromTerms } from '@/domain/score';
import { subtypeDef } from '@/domain/taxonomy';
import type { CreateReportInput, ScoreTerms } from '@/domain/types';

import { lookupExposure, reverseGeocode } from '../exposure';

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

/** report.exposure_terms (plan §6) is written at intake and re-read by the nightly recompute; it is not part of the public ReportRow. */
export type DerivedReportFields = Omit<ReportRow, 'tenant_id' | 'reporter_display_name' | 'cluster_candidate' | 'photos' | 'events' | 'comment_count'> & { exposure_terms: ExposureInputs };

export function deriveReportFields(input: CreateReportInput, id: string, ctx: CreateReportCtx): DerivedReportFields {
  const def = subtypeDef(input.subtype);
  const anonymous = input.reporterDisplay === 'anonymous';
  const point = publicPoint({ lat: input.lat, lng: input.lng }, id, !anonymous);
  const reporterVoteWeight = 1; // TODO(M1): domain/votes voteWeight({accountAgeDays, hasHomeArea}) once watch areas reach the users repo
  // Exposure proxy from the bundled OSM extract (plan §8); the resident's typed address is exact, otherwise the snap is labelled approximate (plan §4 flow 2).
  const exposure = lookupExposure(input.lat, input.lng);
  const typedAddress = input.addressText?.trim() ?? '';
  const address = typedAddress ? { text: typedAddress, confidence: 'exact' as const } : reverseGeocode(input.lat, input.lng);
  const scored = computeScore({
    severity: { confirmed: null, ai: null, resident: input.severityResident },
    pedsPerDay: exposure.pedsPerDay,
    exposureFlags: exposure.flags,
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
    address_text: address.text,
    address_confidence: address.confidence,
    score: scored.score,
    score_terms: scored.terms,
    exposure_terms: exposure,
    storm_multiplier: scored.stormMultiplier,
    vote_count: 1, // the reporter's own vote (plan §4 flow 2)
    reporter_vote_weight: reporterVoteWeight,
    flags: {},
    created_at: ctx.now,
    updated_at: ctx.now,
  };
}
