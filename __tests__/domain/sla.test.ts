/**
 * sla.ts — the O10 SLA table and read-time state: on_track / at_risk (within 20 % of a deadline) / breached.
 */
import { AT_RISK_FRACTION, SLA_CONFIG, slaDeadlines, slaStages, slaState, type SlaReportLike } from '@/domain/sla';
import { DAY_MS } from '@/domain/time';

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.parse('2026-03-02T12:00:00Z');
const report = (over: Partial<SlaReportLike> = {}): SlaReportLike => ({ severity: 3, status: 'new', createdAt: T0, ...over });
const stageState = (r: SlaReportLike, now: number) => Object.fromEntries(slaStages(r, now).map((s) => [s.stage, s.state]));

describe('SLA table', () => {
  test('matches the spec O10 matrix (prose cells as plan §6 numbers)', () => {
    expect(SLA_CONFIG[4]).toEqual({ ack: 15 * MIN, assess: 2 * HOUR, mitigate: DAY_MS, fix: 30 * DAY_MS });
    expect(SLA_CONFIG[3]).toEqual({ ack: DAY_MS, assess: 10 * DAY_MS, mitigate: 14 * DAY_MS, fix: 90 * DAY_MS });
    expect(SLA_CONFIG[2]).toEqual({ ack: 3 * DAY_MS, assess: 30 * DAY_MS, mitigate: null, fix: 120 * DAY_MS });
    expect(SLA_CONFIG[1]).toEqual({ ack: 5 * DAY_MS, assess: 90 * DAY_MS, mitigate: null, fix: 365 * DAY_MS });
    expect(AT_RISK_FRACTION).toBe(0.2);
  });

  test('deadlines are creation + interval; bands without a mitigate clock give null', () => {
    expect(slaDeadlines(T0, 4)).toEqual({ ack: T0 + 15 * MIN, assess: T0 + 2 * HOUR, mitigate: T0 + DAY_MS, fix: T0 + 30 * DAY_MS });
    expect(slaDeadlines(new Date(T0).toISOString(), 2).mitigate).toBeNull();
    expect(slaDeadlines(T0, 1).fix).toBe(T0 + 365 * DAY_MS);
  });
});

describe('slaState for a high (band 3) report', () => {
  test('fresh → on_track; within 20 % of the 1-day ack deadline → at_risk; past it → breached', () => {
    expect(slaState(report(), T0 + HOUR)).toBe('on_track');
    expect(slaState(report(), T0 + 19 * HOUR)).toBe('on_track'); // 5 h left > 4.8 h
    expect(slaState(report(), T0 + 20 * HOUR)).toBe('at_risk'); // 4 h left < 4.8 h
    expect(slaState(report(), T0 + 25 * HOUR)).toBe('breached');
  });

  test('an acknowledgement in time meets the stage; the next clock keeps running', () => {
    const r = report({ status: 'triaged', firstAckAt: T0 + 2 * HOUR });
    expect(stageState(r, T0 + 2 * DAY_MS)).toEqual({ ack: 'met', assess: 'on_track', mitigate: 'on_track', fix: 'on_track' });
    expect(slaState(r, T0 + 2 * DAY_MS)).toBe('on_track');
    expect(slaState(r, T0 + 9 * DAY_MS)).toBe('at_risk'); // assess due at 10 d, 1 d left < 2 d
    expect(slaState(r, T0 + 11 * DAY_MS)).toBe('breached');
  });

  test('a late acknowledgement stays breached after the fact', () => {
    const r = report({ status: 'triaged', firstAckAt: T0 + 30 * HOUR });
    expect(stageState(r, T0 + 40 * HOUR).ack).toBe('breached');
    expect(slaState(r, T0 + 40 * HOUR)).toBe('breached');
  });

  test('a later stage satisfies the earlier ones (assessed on day 2 counts as acknowledged)', () => {
    const r = report({ status: 'assessed', assessedAt: new Date(T0 + 2 * HOUR).toISOString() });
    expect(stageState(r, T0 + 3 * DAY_MS)).toEqual({ ack: 'met', assess: 'met', mitigate: 'on_track', fix: 'on_track' });
  });

  test('the fix clock: everything else done, 10 of 90 days left → at_risk', () => {
    const r = report({ status: 'scheduled', firstAckAt: T0 + DAY_MS, assessedAt: T0 + 2 * DAY_MS, mitigatedAt: T0 + 3 * DAY_MS });
    expect(slaState(r, T0 + 60 * DAY_MS)).toBe('on_track');
    expect(slaState(r, T0 + 80 * DAY_MS)).toBe('at_risk');
    expect(slaState(r, T0 + 91 * DAY_MS)).toBe('breached');
  });

  test('a report fixed without a recorded mitigation breaches the mitigate clock when the fix came late', () => {
    const early = report({ status: 'completed', firstAckAt: T0 + HOUR, assessedAt: T0 + 2 * DAY_MS, completedAt: T0 + 10 * DAY_MS });
    expect(stageState(early, T0 + 100 * DAY_MS)).toEqual({ ack: 'met', assess: 'met', mitigate: 'met', fix: 'met' });
    expect(slaState(early, T0 + 100 * DAY_MS)).toBe('on_track');
    const late = report({ status: 'completed', firstAckAt: T0 + HOUR, assessedAt: T0 + 2 * DAY_MS, completedAt: T0 + 20 * DAY_MS });
    expect(stageState(late, T0 + 100 * DAY_MS).mitigate).toBe('breached');
  });
});

describe('other bands and statuses', () => {
  test('emergency (band 4): 15-minute acknowledgement, at risk from minute 12', () => {
    const r = report({ severity: 4 });
    expect(slaState(r, T0 + 10 * MIN)).toBe('on_track');
    expect(slaState(r, T0 + 13 * MIN)).toBe('at_risk');
    expect(slaState(r, T0 + 16 * MIN)).toBe('breached');
    expect(slaState(report({ severity: 4, firstAckAt: T0 + 5 * MIN }), T0 + 90 * MIN)).toBe('on_track'); // assess due at 2 h, 30 min left > 24 min
    expect(slaState(report({ severity: 4, firstAckAt: T0 + 5 * MIN }), T0 + 100 * MIN)).toBe('at_risk');
  });

  test('moderate and low bands have no mitigate clock — the stage is skipped, never breached', () => {
    const stages = slaStages(report({ severity: 2, firstAckAt: T0 + HOUR }), T0 + 5 * DAY_MS);
    expect(stages.find((s) => s.stage === 'mitigate')).toMatchObject({ due: null, state: 'skipped' });
    expect(slaState(report({ severity: 2, firstAckAt: T0 + HOUR }), T0 + 5 * DAY_MS)).toBe('on_track');
    expect(slaState(report({ severity: 1 }), T0 + 3.9 * DAY_MS)).toBe('on_track'); // 5-day ack clock: at risk from day 4
    expect(slaState(report({ severity: 1 }), T0 + 4 * DAY_MS)).toBe('at_risk');
    expect(slaState(report({ severity: 1 }), T0 + 6 * DAY_MS)).toBe('breached');
  });

  test('a rejected report owes nothing: every stage skipped, on_track however old', () => {
    const r = report({ status: 'rejected' });
    expect(slaStages(r, T0 + 400 * DAY_MS).every((s) => s.state === 'skipped')).toBe(true);
    expect(slaState(r, T0 + 400 * DAY_MS)).toBe('on_track');
  });

  test('ISO strings and epoch numbers are interchangeable; unparsable stamps count as not done', () => {
    const iso = report({ createdAt: new Date(T0).toISOString(), firstAckAt: 'not a date' });
    expect(slaState(iso, T0 + 25 * HOUR)).toBe('breached');
    expect(slaState(report({ firstAckAt: new Date(T0 + HOUR).toISOString() }), T0 + 25 * HOUR)).toBe('on_track');
  });
});
