/**
 * votes.ts — weights, the 1.5 km geo check, thresholds and anomaly flags (plan §1.3, §12, §14).
 */
import { metresPerDegree, type LatLng } from '@/domain/geo';
import { ANOMALY, GEO_RADIUS_M, NEW_ACCOUNT_DAYS, SUSPICIOUS_WEIGHT, VOTE_THRESHOLDS, anomalyFlags, geoCheck, thresholdFlags, voteWeight } from '@/domain/votes';

const report: LatLng = { lat: 40.4862, lng: -74.4518 };
/** A point `m` metres north of the report (haversine 1° lat ≈ 111 195 m). */
const north = (m: number): LatLng => ({ lat: report.lat + m / 111_195, lng: report.lng });
const east = (m: number): LatLng => ({ lat: report.lat, lng: report.lng + m / metresPerDegree(report.lat).lng });

describe('voteWeight', () => {
  test('0.6 for accounts younger than 7 days or without a home area, else 1.0', () => {
    expect(NEW_ACCOUNT_DAYS).toBe(7);
    expect(voteWeight({ accountAgeDays: 7, hasHomeArea: true })).toBe(1);
    expect(voteWeight({ accountAgeDays: 400, hasHomeArea: true })).toBe(1);
    expect(voteWeight({ accountAgeDays: 6, hasHomeArea: true })).toBe(0.6);
    expect(voteWeight({ accountAgeDays: 0, hasHomeArea: true })).toBe(0.6);
    expect(voteWeight({ accountAgeDays: 30, hasHomeArea: false })).toBe(0.6);
    expect(voteWeight({ accountAgeDays: Number.NaN, hasHomeArea: true })).toBe(0.6);
    expect(SUSPICIOUS_WEIGHT).toBe(0.5);
  });
});

describe('geoCheck', () => {
  test('no home/watch point → accepted but unverified', () => {
    expect(geoCheck(null, report)).toEqual({ unverifiedGeo: true, distanceM: null });
  });

  test('within 1.5 km → verified; beyond → unverified, distance reported either way', () => {
    expect(GEO_RADIUS_M).toBe(1500);
    expect(geoCheck(report, report)).toEqual({ unverifiedGeo: false, distanceM: 0 });
    const near = geoCheck(north(1400), report);
    expect(near.unverifiedGeo).toBe(false);
    expect(near.distanceM).toBeCloseTo(1400, -1);
    const far = geoCheck(east(1600), report);
    expect(far.unverifiedGeo).toBe(true);
    expect(far.distanceM).toBeCloseTo(1600, -1);
    expect(geoCheck({ lat: 40.7128, lng: -74.006 }, report).unverifiedGeo).toBe(true); // Manhattan
  });
});

describe('anomalyFlags', () => {
  test('nothing unusual → no flags', () => {
    expect(anomalyFlags({ votesLastHourByInstall: 3, accountsPerInstall: 1, distanceM: 900 })).toEqual([]);
    expect(anomalyFlags({ votesLastHourByInstall: ANOMALY.votesPerHourPerInstall, accountsPerInstall: ANOMALY.accountsPerInstall, distanceM: ANOMALY.farAwayM })).toEqual([]);
  });

  test('each signal flags on its own and they combine in a fixed order', () => {
    expect(anomalyFlags({ votesLastHourByInstall: ANOMALY.votesPerHourPerInstall + 1, accountsPerInstall: 1, distanceM: null })).toEqual(['velocity']);
    expect(anomalyFlags({ votesLastHourByInstall: 0, accountsPerInstall: ANOMALY.accountsPerInstall + 1, distanceM: null })).toEqual(['shared_install']);
    expect(anomalyFlags({ votesLastHourByInstall: 0, accountsPerInstall: 1, distanceM: ANOMALY.farAwayM + 1 })).toEqual(['far_away']);
    expect(anomalyFlags({ votesLastHourByInstall: 0, accountsPerInstall: 1, distanceM: null })).toEqual([]);
    expect(anomalyFlags({ votesLastHourByInstall: 99, accountsPerInstall: 9, distanceM: 1e6 })).toEqual(['velocity', 'shared_install', 'far_away']);
  });
});

describe('thresholds', () => {
  test('25 → supervisor review, 100 → council item', () => {
    expect(VOTE_THRESHOLDS).toEqual({ supervisorReview: 25, councilItem: 100 });
    expect(thresholdFlags(24)).toEqual({ supervisorReview: false, councilItem: false });
    expect(thresholdFlags(25)).toEqual({ supervisorReview: true, councilItem: false });
    expect(thresholdFlags(100)).toEqual({ supervisorReview: true, councilItem: true });
  });
});
