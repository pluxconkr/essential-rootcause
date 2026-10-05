/**
 * status.ts — the full allowed/denied matrix (status × status × role), evidence rules (after-photo,
 * confirmations, rejection reason) and the system-only verification moves (plan §1.3, §14).
 */
import { AUTO_VERIFY_DAYS, CITYWORKS_STATUS, OPEN311_STATUS, REOPEN_REJECTIONS, RESIDENT_WORDING, VERIFY_CONFIRMATIONS, isOpen, nextStatuses, transition, type TransitionCtx } from '@/domain/status';
import { REPORT_STATUSES, ROLES, type ReportStatus, type Role } from '@/domain/types';

type Who = Role | 'system';
const WHO: readonly Who[] = [...ROLES, 'system'];
const STAFF: readonly Who[] = ['inspector', 'supervisor', 'director'];
const SUPERVISOR_UP: readonly Who[] = ['supervisor', 'director'];
const SYSTEM: readonly Who[] = ['system'];

/** Every piece of evidence present, so a denial below is about the role or the edge, never the context. */
const full: TransitionCtx = { hasAfterPhoto: true, confirmations: 2, rejections: 1, autoVerify: false, reason: 'Private property — owner notified' };

const ALLOWED: readonly [ReportStatus, ReportStatus, readonly Who[]][] = [
  ['new', 'triaged', STAFF],
  ['triaged', 'assessed', STAFF],
  ['assessed', 'mitigated', STAFF],
  ['assessed', 'scheduled', SUPERVISOR_UP],
  ['mitigated', 'scheduled', SUPERVISOR_UP],
  ['assessed', 'completed', STAFF],
  ['mitigated', 'completed', STAFF],
  ['scheduled', 'completed', STAFF],
  ['completed', 'verified', SYSTEM],
  ['completed', 'assessed', SYSTEM],
  ['new', 'rejected', STAFF],
  ['triaged', 'rejected', STAFF],
  ['assessed', 'rejected', STAFF],
  ['mitigated', 'rejected', STAFF],
  ['scheduled', 'rejected', STAFF],
];

describe('transition matrix', () => {
  test('every (from, to, actor) triple matches the allowed table — with full evidence', () => {
    const rows: { from: ReportStatus; to: ReportStatus; who: Who; ok: boolean }[] = [];
    const expected: typeof rows = [];
    for (const from of REPORT_STATUSES) {
      for (const to of REPORT_STATUSES) {
        for (const who of WHO) {
          const allowed = ALLOWED.some(([f, t, roles]) => f === from && t === to && roles.includes(who));
          rows.push({ from, to, who, ok: transition(from, to, { role: who }, full).ok });
          expected.push({ from, to, who, ok: allowed });
        }
      }
    }
    expect(rows).toEqual(expected);
    expect(rows.filter((r) => r.ok)).toHaveLength(ALLOWED.reduce((n, [, , roles]) => n + roles.length, 0));
  });

  test('residents, stewards and the auditor can never move a report', () => {
    for (const who of ['resident', 'steward', 'auditor'] as const) {
      for (const from of REPORT_STATUSES) for (const to of REPORT_STATUSES) expect(transition(from, to, { role: who }, full).ok).toBe(false);
    }
  });

  test('a denial always carries a readable reason', () => {
    const r = transition('new', 'completed', { role: 'inspector' }, full);
    expect(r).toEqual({ ok: false, reason: 'no move from new to completed' });
    expect(transition('triaged', 'triaged', { role: 'director' }, full)).toEqual({ ok: false, reason: 'already triaged' });
  });
});

describe('evidence rules', () => {
  test('completing needs an after-photo from every open stage that allows it', () => {
    for (const from of ['assessed', 'mitigated', 'scheduled'] as const) {
      expect(transition(from, 'completed', { role: 'inspector' }, { hasAfterPhoto: false })).toEqual({ ok: false, reason: 'completing needs an after-photo' });
      expect(transition(from, 'completed', { role: 'inspector' }, { hasAfterPhoto: true }).ok).toBe(true);
    }
  });

  test('verified is system-only: 2 confirmations or the 14-day auto-verify', () => {
    expect(VERIFY_CONFIRMATIONS).toBe(2);
    expect(AUTO_VERIFY_DAYS).toBe(14);
    expect(transition('completed', 'verified', { role: 'director' }, full).ok).toBe(false);
    expect(transition('completed', 'verified', { role: 'system' }, { hasAfterPhoto: true, confirmations: 1 }).ok).toBe(false);
    expect(transition('completed', 'verified', { role: 'system' }, { hasAfterPhoto: true, confirmations: 2 }).ok).toBe(true);
    expect(transition('completed', 'verified', { role: 'system' }, { hasAfterPhoto: true, confirmations: 0, autoVerify: true }).ok).toBe(true);
    expect(transition('completed', 'verified', { role: 'system' }, { hasAfterPhoto: true })).toEqual({ ok: false, reason: 'verified needs 2 confirmations or 14 days of silence' });
  });

  test('the system reopens a completed report to assessed on one rejection with photo', () => {
    expect(REOPEN_REJECTIONS).toBe(1);
    expect(transition('completed', 'assessed', { role: 'system' }, { hasAfterPhoto: true, rejections: 0 })).toEqual({ ok: false, reason: 'reopening needs a rejection with a photo' });
    expect(transition('completed', 'assessed', { role: 'system' }, { hasAfterPhoto: true, rejections: 1 }).ok).toBe(true);
    expect(transition('completed', 'assessed', { role: 'inspector' }, full).ok).toBe(false);
    expect(transition('scheduled', 'completed', { role: 'system' }, full).ok).toBe(false);
    expect(transition('completed', 'scheduled', { role: 'system' }, full).ok).toBe(false);
  });

  test('rejecting needs a reason, works from any open status and never from a closed one', () => {
    expect(transition('new', 'rejected', { role: 'inspector' }, { hasAfterPhoto: false })).toEqual({ ok: false, reason: 'a rejection needs a reason the resident will see' });
    expect(transition('new', 'rejected', { role: 'inspector' }, { hasAfterPhoto: false, reason: '   ' }).ok).toBe(false);
    expect(transition('new', 'rejected', { role: 'inspector' }, { hasAfterPhoto: false, reason: 'County road — forwarded to Middlesex County' }).ok).toBe(true);
    expect(transition('completed', 'rejected', { role: 'director' }, full).ok).toBe(false);
    expect(transition('verified', 'rejected', { role: 'director' }, full).ok).toBe(false);
    expect(transition('rejected', 'new', { role: 'director' }, full).ok).toBe(false);
  });
});

describe('nextStatuses', () => {
  test('lists only the moves this actor can make with the evidence at hand', () => {
    expect(nextStatuses('assessed', { role: 'supervisor' }, { hasAfterPhoto: false, reason: 'x' })).toEqual(['mitigated', 'scheduled', 'rejected']);
    expect(nextStatuses('assessed', { role: 'inspector' }, { hasAfterPhoto: true, reason: 'x' })).toEqual(['mitigated', 'completed', 'rejected']);
    expect(nextStatuses('new', { role: 'inspector' }, { hasAfterPhoto: false })).toEqual(['triaged']);
    expect(nextStatuses('completed', { role: 'system' }, { hasAfterPhoto: true, confirmations: 2, rejections: 0 })).toEqual(['verified']);
    expect(nextStatuses('verified', { role: 'director' }, full)).toEqual([]);
    expect(nextStatuses('new', { role: 'resident' }, full)).toEqual([]);
  });
});

describe('mapping tables', () => {
  test('Open311: five open statuses, three closed; isOpen follows it', () => {
    expect(OPEN311_STATUS).toEqual({ new: 'open', triaged: 'open', assessed: 'open', mitigated: 'open', scheduled: 'open', completed: 'closed', verified: 'closed', rejected: 'closed' });
    expect(REPORT_STATUSES.filter(isOpen)).toEqual(['new', 'triaged', 'assessed', 'mitigated', 'scheduled']);
  });

  test('Cityworks: the spec example column, one entry per status (plan §3.11 sync seam)', () => {
    expect(CITYWORKS_STATUS).toEqual({ new: 'REQUEST', triaged: 'REQUEST/REVIEWED', assessed: 'WO/CREATED', mitigated: 'WO/TEMP', scheduled: 'WO/SCHEDULED', completed: 'WO/CLOSED', verified: 'WO/CLOSED', rejected: 'REQUEST/CANCEL' });
    expect(Object.keys(CITYWORKS_STATUS).sort()).toEqual([...REPORT_STATUSES].sort());
  });

  test('resident wording covers all 8 statuses with the Appendix B text', () => {
    expect(Object.keys(RESIDENT_WORDING).sort()).toEqual([...REPORT_STATUSES].sort());
    expect(RESIDENT_WORDING).toEqual({
      new: 'Received',
      triaged: 'Confirmed by inspector',
      assessed: 'Assessed in the field',
      mitigated: 'Made safe temporarily',
      scheduled: 'Scheduled — window given',
      completed: 'Fixed — please verify',
      verified: 'Fix confirmed by a resident',
      rejected: "Not city-owned — here's who owns it",
    });
  });
});
