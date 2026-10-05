/**
 * demo.ts — deterministic, labelled demo data: 12 reports per scenario, scores from the formula, one completed
 * report in `verify`, the rain multiplier only in `storm`, and the clock offsets that land on each scenario's time.
 */
import { DEMO_SCENARIOS, SCENARIO_CLOCK, VERIFY_SEQ, buildDemoReports, clockOffsetFor, demoReportId } from '@/domain/demo';
import { distanceM } from '@/domain/geo';
import { PILOT } from '@/domain/pilot';
import { DEFAULT_WEIGHTS, scoreFromTerms } from '@/domain/score';
import { localMinutes } from '@/domain/time';
import { PublicReportSchema, type DemoScenario } from '@/domain/types';

const NOW = Date.parse('2026-10-05T21:30:00Z'); // 5:30 PM EDT
const SCENARIOS: readonly DemoScenario[] = ['calm', 'storm', 'verify'];

describe('buildDemoReports', () => {
  test('12 reports, all labelled demo, valid against the public schema, unique ids, within 1.2 km of the centre', () => {
    for (const s of SCENARIOS) {
      const reports = buildDemoReports(s, PILOT.center, NOW);
      expect(reports).toHaveLength(12);
      expect(new Set(reports.map((r) => r.id)).size).toBe(12);
      for (const r of reports) {
        expect(r.isDemo).toBe(true);
        expect(PublicReportSchema.safeParse(r).success).toBe(true);
        expect(distanceM(PILOT.center, r)).toBeGreaterThanOrEqual(140);
        expect(distanceM(PILOT.center, r)).toBeLessThanOrEqual(1210);
        expect(r.id.startsWith('demo-wo-')).toBe(true);
      }
    }
  });

  test('deterministic: same scenario, centre and clock → identical output', () => {
    expect(buildDemoReports('storm', PILOT.center, NOW)).toEqual(buildDemoReports('storm', PILOT.center, NOW));
    expect(buildDemoReports('calm', PILOT.center, NOW)).toEqual(buildDemoReports('calm', { ...PILOT.center }, NOW));
  });

  test('moving the centre moves every report with it', () => {
    const here = buildDemoReports('calm', PILOT.center, NOW);
    const there = buildDemoReports('calm', { lat: 40.5, lng: -74.6 }, NOW);
    there.forEach((r, i) => {
      expect(r.id).toBe(here[i]!.id);
      expect(distanceM(r, here[i]!)).toBeGreaterThan(10_000);
    });
  });

  test('scores are the formula applied to the shown terms (T8), and band 4 only when confirmed', () => {
    for (const r of buildDemoReports('storm', PILOT.center, NOW)) {
      expect(r.score).toBe(scoreFromTerms(r.scoreTerms, DEFAULT_WEIGHTS, r.stormMultiplier));
      if (r.severity === 4) expect(r.severityConfirmed).toBe(true);
      expect(r.slaState).toBeDefined();
      expect(r.commentCount).toBeGreaterThanOrEqual(0);
    }
  });

  test('timeline: starts with created, is ordered in time, ends at the current status', () => {
    for (const r of buildDemoReports('verify', PILOT.center, NOW)) {
      expect(r.timeline[0]).toMatchObject({ kind: 'created', fromStatus: null, toStatus: 'new' });
      expect(r.timeline[0]!.at).toBe(r.createdAt);
      const ats = r.timeline.map((e) => Date.parse(e.at));
      expect([...ats].sort((a, b) => a - b)).toEqual(ats);
      expect(ats[ats.length - 1]).toBeLessThanOrEqual(NOW);
      expect(r.timeline[r.timeline.length - 1]!.toStatus).toBe(r.status);
      expect(r.updatedAt).toBe(r.timeline[r.timeline.length - 1]!.at);
      expect(Date.parse(r.createdAt)).toBeLessThan(NOW);
    }
  });

  test('calm: no multiplier anywhere, nothing completed', () => {
    const reports = buildDemoReports('calm', PILOT.center, NOW);
    expect(reports.every((r) => r.stormMultiplier === 1)).toBe(true);
    expect(reports.filter((r) => r.status === 'completed')).toHaveLength(0);
  });

  test('storm: rain-sensitive reports carry ×1.4 and outrank their calm selves; others are untouched', () => {
    const calm = buildDemoReports('calm', PILOT.center, NOW);
    const storm = buildDemoReports('storm', PILOT.center, NOW);
    const rainy = storm.filter((r) => r.stormSensitivity.includes('rain'));
    const dry = storm.filter((r) => !r.stormSensitivity.includes('rain'));
    expect(rainy.length).toBeGreaterThan(0);
    expect(dry.length).toBeGreaterThan(0);
    expect(rainy.every((r) => r.stormMultiplier === 1.4)).toBe(true);
    expect(dry.every((r) => r.stormMultiplier === 1)).toBe(true);
    storm.forEach((r, i) => {
      expect(r.scoreTerms).toEqual(calm[i]!.scoreTerms);
      if (r.stormSensitivity.includes('rain')) expect(r.score).toBeGreaterThan(calm[i]!.score);
      else expect(r.score).toBe(calm[i]!.score);
    });
  });

  test('verify: exactly one report is completed two days ago and awaits confirmation', () => {
    const reports = buildDemoReports('verify', PILOT.center, NOW);
    const done = reports.filter((r) => r.status === 'completed');
    expect(done).toHaveLength(1);
    expect(done[0]!.id).toBe(demoReportId(VERIFY_SEQ));
    expect(done[0]!.timeline.map((e) => e.toStatus)).toEqual(['new', 'triaged', 'assessed', 'scheduled', 'completed']);
    expect(Date.parse(done[0]!.updatedAt)).toBe(NOW - 2 * 86_400_000);
    expect(done[0]!.timeline[4]!.note).toMatch(/confirm/);
    const sameInCalm = buildDemoReports('calm', PILOT.center, NOW).find((r) => r.id === done[0]!.id)!;
    expect(sameInCalm.status).toBe('scheduled');
  });
});

describe('scenario definitions and clock', () => {
  test('three scenarios with labels; calm runs on real time; the storm advisory names a place and an action', () => {
    expect(Object.keys(DEMO_SCENARIOS)).toEqual(['calm', 'storm', 'verify']);
    for (const s of SCENARIOS) expect(DEMO_SCENARIOS[s].label.length).toBeGreaterThan(3);
    expect(SCENARIO_CLOCK.calm).toBeNull();
    expect(DEMO_SCENARIOS.calm.clockOffsetMs).toBe(0);
    expect(DEMO_SCENARIOS.storm.storm).toEqual({ kind: 'rain', multiplier: 1.4, onsetMinutes: 21 * 60 + 30 });
    expect(DEMO_SCENARIOS.storm.alertTitle).toMatch(/rain/i);
    expect(DEMO_SCENARIOS.storm.alertBody).toMatch(/St\b/); // a place
    expect(DEMO_SCENARIOS.storm.alertBody).toMatch(/Report|use the/); // an action
  });

  test('clockOffsetMs is read live, so it lands on the scenario time of day today', () => {
    expect(localMinutes(Date.now() + DEMO_SCENARIOS.storm.clockOffsetMs)).toBe(17 * 60 + 30);
    expect(localMinutes(Date.now() + DEMO_SCENARIOS.verify.clockOffsetMs)).toBe(9 * 60 + 30);
  });

  test('clockOffsetFor lands the app clock on the scenario time of day, whatever the real time', () => {
    for (const realNow of [NOW, Date.parse('2026-01-16T04:07:00Z'), Date.parse('2026-07-15T12:59:00Z')]) {
      expect(clockOffsetFor('calm', realNow)).toBe(0);
      expect(localMinutes(realNow + clockOffsetFor('storm', realNow))).toBe(17 * 60 + 30);
      expect(localMinutes(realNow + clockOffsetFor('verify', realNow))).toBe(9 * 60 + 30);
    }
  });
});
