/**
 * score.ts — oracles derived from the spec §7 formula (plan §8, §14), never from the prototype's placeholder scores.
 */
import { ACTIVE_USERS_FLOOR, COMMUNITY_K, DEFAULT_WEIGHTS, SEVERITY_BAND, UNRATED_BAND, communityTerm, computeScore, decayTerm, effectiveSeverity, explain, exposureTerm, liabilityTerm, scoreFromTerms, severitySource, stormMultiplierFor, vulnMultiplier, type ActiveScenario } from '@/domain/score';
import { ScoreTermsSchema, type ScoreTerms } from '@/domain/types';

const worked: ScoreTerms = { severity: 0.78, exposure: 0.82, community: 0.12, liability: 0.9, decay: 0.04 };

describe('score formula', () => {
  test('worked example .78/.82/.12/.90/.04 → 60 (100 × 0.602 = 60.2 → 60)', () => {
    expect(scoreFromTerms(worked)).toBe(60);
  });

  test('weights are the spec defaults and sum to 1', () => {
    expect(DEFAULT_WEIGHTS).toEqual({ severity: 0.32, exposure: 0.24, community: 0.22, liability: 0.14, decay: 0.08 });
    expect(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(COMMUNITY_K).toBe(0.25);
    expect(ACTIVE_USERS_FLOOR).toBe(20);
  });

  test('bounds: all terms 1 → 100, all 0 → 0', () => {
    expect(scoreFromTerms({ severity: 1, exposure: 1, community: 1, liability: 1, decay: 1 })).toBe(100);
    expect(scoreFromTerms({ severity: 0, exposure: 0, community: 0, liability: 0, decay: 0 })).toBe(0);
  });

  test('storm multiplier scales the whole sum and is clamped to 1.0–1.6', () => {
    expect(scoreFromTerms(worked, DEFAULT_WEIGHTS, 1.4)).toBe(84); // 60.2 × 1.4 = 84.28
    expect(scoreFromTerms(worked, DEFAULT_WEIGHTS, 2)).toBe(96); // clamped to 1.6: 60.2 × 1.6 = 96.32
    expect(scoreFromTerms(worked, DEFAULT_WEIGHTS, 0.5)).toBe(60); // never below 1.0
    expect(scoreFromTerms(worked, DEFAULT_WEIGHTS, Number.NaN)).toBe(60);
  });
});

describe('effectiveSeverity', () => {
  test('bands map to the spec terms', () => {
    expect(SEVERITY_BAND).toEqual({ 1: 0.25, 2: 0.5, 3: 0.78, 4: 1 });
  });

  test('confirmed beats ai beats resident', () => {
    expect(effectiveSeverity({ confirmed: 1, ai: 4, resident: 4 })).toBe(1);
    expect(effectiveSeverity({ confirmed: null, ai: 3, resident: 4 })).toBe(3);
    expect(effectiveSeverity({ confirmed: 4, ai: null, resident: null })).toBe(4);
    expect(severitySource({ confirmed: 4, ai: 3, resident: 2 })).toBe('confirmed');
    expect(severitySource({ confirmed: null, ai: 3, resident: 2 })).toBe('ai');
    expect(severitySource({ confirmed: null, ai: null, resident: 2 })).toBe('resident');
  });

  test('a resident "Emergency" scores as band 3 until a human confirms it', () => {
    expect(effectiveSeverity({ confirmed: null, ai: null, resident: 4 })).toBe(3);
    expect(effectiveSeverity({ confirmed: null, ai: null, resident: 3 })).toBe(3);
    expect(effectiveSeverity({ confirmed: null, ai: null, resident: 2 })).toBe(2);
    expect(effectiveSeverity({ confirmed: null, ai: null, resident: 1 })).toBe(1);
  });

  test('no answer at all → band 2, labelled unrated', () => {
    expect(effectiveSeverity({ confirmed: null, ai: null, resident: null })).toBe(UNRATED_BAND);
    expect(UNRATED_BAND).toBe(2);
    expect(severitySource({ confirmed: null, ai: null, resident: null })).toBe('unrated');
  });
});

describe('exposureTerm', () => {
  test('log-normalised against 5000 pedestrians/day', () => {
    expect(exposureTerm(0)).toBe(0);
    expect(exposureTerm(5000)).toBe(1);
    expect(exposureTerm(1240)).toBeCloseTo(Math.log1p(1240) / Math.log1p(5000), 10);
    expect(exposureTerm(1240)).toBeCloseTo(0.8364, 3);
    expect(exposureTerm(-10)).toBe(0);
    expect(exposureTerm(Number.NaN)).toBe(0);
  });

  test('vulnerable-population multiplier adds .15/.15/.10/.10 and caps at 1.4', () => {
    expect(vulnMultiplier()).toBe(1);
    expect(vulnMultiplier({ schoolRoute: true })).toBeCloseTo(1.15, 10);
    expect(vulnMultiplier({ schoolRoute: true, seniorFacility: true })).toBeCloseTo(1.3, 10);
    expect(vulnMultiplier({ schoolRoute: true, seniorFacility: true, transitStop: true, adaRoute: true })).toBe(1.4);
    expect(exposureTerm(1240, { schoolRoute: true })).toBeCloseTo(0.8364 * 1.15, 3);
  });

  test('the term never leaves 0..1 even with the multiplier', () => {
    expect(exposureTerm(100_000, { schoolRoute: true, seniorFacility: true, transitStop: true })).toBe(1);
  });
});

describe('communityTerm', () => {
  test('zero votes → 0; saturates at 1', () => {
    expect(communityTerm(0, 100)).toBe(0);
    expect(communityTerm(1000, 100)).toBe(1);
    expect(communityTerm(5, 100)).toBeLessThanOrEqual(communityTerm(10, 100));
    expect(communityTerm(10, 100)).toBeLessThanOrEqual(communityTerm(20, 100));
  });

  test('the active-users floor stops a tiny block group saturating on two votes', () => {
    expect(communityTerm(3, 5)).toBe(communityTerm(3, 20));
    expect(communityTerm(3, 1)).toBe(communityTerm(3, ACTIVE_USERS_FLOOR));
  });

  test('formula-derived values: Σw 2 over k×N = 5 → log1p(2)/log1p(5)', () => {
    expect(communityTerm(2, 20)).toBeCloseTo(Math.log1p(2) / Math.log1p(5), 10);
    expect(communityTerm(2, 20)).toBeCloseTo(0.6132, 3);
    expect(communityTerm(2, 20, 1)).toBeCloseTo(Math.log1p(2) / Math.log1p(20), 10);
    expect(communityTerm(2, 200, 0.25, 20)).toBeCloseTo(Math.log1p(2) / Math.log1p(50), 10);
  });
});

describe('liabilityTerm', () => {
  test('max of ADA .9, injury 1.0, near miss .5, prior notice > 90 days .7', () => {
    expect(liabilityTerm(false, 'no', 0)).toBe(0);
    expect(liabilityTerm(true, 'no', 0)).toBe(0.9);
    expect(liabilityTerm(false, 'injury', 0)).toBe(1);
    expect(liabilityTerm(false, 'near_miss', 0)).toBe(0.5);
    expect(liabilityTerm(false, 'no', 91)).toBe(0.7);
    expect(liabilityTerm(false, 'no', 90)).toBe(0);
    expect(liabilityTerm(true, 'injury', 200)).toBe(1);
    expect(liabilityTerm(true, 'near_miss', 100)).toBe(0.9);
    expect(liabilityTerm(false, 'no', null)).toBe(0);
  });
});

describe('decayTerm', () => {
  test('days open / 365, clamped', () => {
    expect(decayTerm(0)).toBe(0);
    expect(decayTerm(182.5)).toBe(0.5);
    expect(decayTerm(365)).toBe(1);
    expect(decayTerm(730)).toBe(1);
    expect(decayTerm(-5)).toBe(0);
  });
});

describe('storm multiplier timing', () => {
  const rain: ActiveScenario = { kind: 'rain', multiplier: 1.4, startsAt: 1000, endsAt: 2000 };

  test('applies only inside the window and only to sensitive reports', () => {
    expect(stormMultiplierFor(['rain'], rain, 1500)).toBe(1.4);
    expect(stormMultiplierFor(['rain', 'freeze'], rain, 1000)).toBe(1.4);
    expect(stormMultiplierFor(['rain'], rain, 999)).toBe(1);
    expect(stormMultiplierFor(['rain'], rain, 2000)).toBe(1);
    expect(stormMultiplierFor(['wind'], rain, 1500)).toBe(1);
    expect(stormMultiplierFor([], rain, 1500)).toBe(1);
    expect(stormMultiplierFor(['rain'], null, 1500)).toBe(1);
  });

  test('scenario multipliers are clamped to the published 1.0–1.6 range', () => {
    expect(stormMultiplierFor(['rain'], { ...rain, multiplier: 2.5 }, 1500)).toBe(1.6);
    expect(stormMultiplierFor(['rain'], { ...rain, multiplier: 0.8 }, 1500)).toBe(1);
  });
});

describe('computeScore', () => {
  const input = { severity: { confirmed: null, ai: null, resident: 4 as const }, pedsPerDay: 1240, exposureFlags: { schoolRoute: true }, voteWeightSum: 2, activeUsers: 5, adaFlag: true, injuryFlag: 'injury' as const, priorNoticeDays: 0, daysOpen: 14, stormMultiplier: 1.4 };

  test('end to end: terms from the formula, score = round(100 × Σ w·term × multiplier)', () => {
    const r = computeScore(input);
    expect(r.terms.severity).toBe(0.78);
    expect(r.terms.exposure).toBeCloseTo(0.9618, 3);
    expect(r.terms.community).toBeCloseTo(0.6132, 3);
    expect(r.terms.liability).toBe(1);
    expect(r.terms.decay).toBeCloseTo(14 / 365, 10);
    expect(r.stormMultiplier).toBe(1.4);
    expect(r.score).toBe(scoreFromTerms(r.terms, DEFAULT_WEIGHTS, 1.4));
    expect(r.score).toBe(106); // (.2496 + .2308 + .1349 + .14 + .0031) × 100 × 1.4 = 106.2
    expect(ScoreTermsSchema.safeParse(r.terms).success).toBe(true);
  });

  test('a resolved band can be passed directly; no multiplier means 1.0', () => {
    const r = computeScore({ ...input, severity: 4, stormMultiplier: undefined });
    expect(r.terms.severity).toBe(1);
    expect(r.stormMultiplier).toBe(1);
    expect(r.score).toBe(scoreFromTerms(r.terms));
  });

  test('tenant weights and community parameters are injectable', () => {
    const r = computeScore({ ...input, weights: { severity: 1, exposure: 0, community: 0, liability: 0, decay: 0 }, stormMultiplier: 1 });
    expect(r.score).toBe(78);
    expect(computeScore({ ...input, communityK: 1, activeUsersFloor: 100 }).terms.community).toBeCloseTo(Math.log1p(2) / Math.log1p(100), 10);
  });
});

describe('explain', () => {
  test('five labelled rows whose points add up to the score', () => {
    const rows = explain(worked);
    expect(rows.map((r) => r.key)).toEqual(['severity', 'exposure', 'community', 'liability', 'decay']);
    expect(rows.map((r) => r.label)).toEqual(['Severity', 'Exposure', 'Community votes', 'Liability / ADA', 'Decay (age)']);
    expect(rows[0]).toMatchObject({ term: 0.78, weight: 0.32, points: 25 });
    expect(rows[0]!.text).toBe('Severity: 0.78 × 0.32 = 25.0 pts');
    expect(rows[1]!.text).toBe('Exposure: 0.82 × 0.24 = 19.7 pts');
    expect(rows.reduce((a, r) => a + r.points, 0)).toBeCloseTo(60.2, 1);
    expect(rows.every((r) => r.meaning.length > 10)).toBe(true);
  });
});
