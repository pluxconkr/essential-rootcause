/**
 * toPublicReport() allow-list (plan §12): the output keys are exactly PUBLIC_FIELDS and validate against
 * PublicReportSchema; a row loaded with every sensitive column — precise point, reporter and uploader ids, draft id,
 * phone, home geometry, watch areas, install id, internal notes, staff-only photos — never leaks one of them.
 */
import { PublicReportSchema } from '@/domain/types';
import { PUBLIC_FIELDS, initials, toPublicReport } from '@/server/public';
import type { ReportRow } from '@/server/repos/types';

const PRECISE = { lat: 40.486211, lng: -74.451877 };

const row = (over: Partial<ReportRow> = {}): ReportRow =>
  ({
    id: 'rc_000042',
    tenant_id: 'pilot',
    client_draft_id: 'd_m2k9x1a3_7f3kq',
    reporter_id: 'u_jane',
    reporter_display: 'named',
    reporter_display_name: 'Jane Q. Doe',
    category: 'sidewalk',
    subtype: 'uneven_sidewalk',
    status: 'triaged',
    severity_resident: 4,
    severity_ai: null,
    severity_confirmed: null,
    emergency_requested: true,
    injury_flag: 'near_miss',
    ada_flag: true,
    storm_sensitivity: ['rain', 'freeze'],
    lat: PRECISE.lat,
    lng: PRECISE.lng,
    public_lat: 40.4864,
    public_lng: -74.4521,
    address_text: '12 Somerset St',
    address_confidence: 'approx',
    score: 61.4,
    score_terms: { severity: 0.78, exposure: 0.82, community: 0.12, liability: 0.9, decay: 0.04 },
    storm_multiplier: 1.2,
    vote_count: 7,
    reporter_vote_weight: 1,
    cluster_candidate: 'rc_000041',
    flags: { suspicious: false },
    created_at: '2026-10-01T12:00:00.000Z',
    updated_at: '2026-10-03T09:30:00.000Z',
    photos: [
      { id: 'ph_pub', phase: 'before', visibility: 'public', uploader_id: 'u_jane', url: 'https://x/pub.jpg?sig', thumb_url: 'https://x/pub_t.jpg?sig' },
      { id: 'ph_staff', phase: 'before', visibility: 'staff_only', uploader_id: 'u_jane', url: 'https://x/staff.jpg?sig', thumb_url: 'https://x/staff_t.jpg?sig' },
    ],
    events: [
      { id: 'ev_1', kind: 'created', actor_type: 'resident', actor_id: 'u_jane', from_status: null, to_status: 'new', note: 'Lip by the curb', created_at: '2026-10-01T12:00:00.000Z' },
      { id: 'ev_2', kind: 'status', actor_type: 'staff', actor_id: 'u_inspector', from_status: 'new', to_status: 'triaged', note: 'Inspection scheduled', created_at: '2026-10-03T09:30:00.000Z' },
    ],
    comment_count: 3,
    // Columns a careless query could drag along; none may survive the projection.
    ...({ home_geom: 'POINT(-74.45 40.48)', phone_e164: '+15551234567', install_id: 'inst_9f3k', watch_areas: [{ radius_m: 400 }], internal_note: 'resident is a repeat caller', email: 'jane@example.org' } as object),
    ...over,
  }) as ReportRow;

const FORBIDDEN = /home_geom|phone|install_id|watch|internal|reporter_id|uploader_id|client_draft_id|clientDraftId|storage_key|email|actor_id|cluster_candidate|\+15551234567|inst_9f3k|repeat caller|jane@example\.org/;

test('emits exactly PUBLIC_FIELDS and validates against the shared schema', () => {
  const out = toPublicReport(row());
  expect(Object.keys(out).sort()).toEqual([...PUBLIC_FIELDS].sort());
  expect(PublicReportSchema.safeParse(out).success).toBe(true);
});

test('never leaks a sensitive column, the precise point or a staff-only photo', () => {
  const out = toPublicReport(row());
  const text = JSON.stringify(out);
  expect(text).not.toMatch(FORBIDDEN);
  expect(text).not.toContain(String(PRECISE.lat));
  expect(text).not.toContain(String(PRECISE.lng));
  expect(out.lat).toBe(40.4864);
  expect(out.lng).toBe(-74.4521);
  expect(out.photos).toEqual([{ id: 'ph_pub', url: 'https://x/pub.jpg?sig', thumbUrl: 'https://x/pub_t.jpg?sig', phase: 'before' }]);
  expect(out.timeline.map((e) => Object.keys(e).sort())).toEqual([
    ['at', 'fromStatus', 'id', 'kind', 'note', 'toStatus'],
    ['at', 'fromStatus', 'id', 'kind', 'note', 'toStatus'],
  ]);
  expect(out.commentCount).toBe(3);
});

test('reporter name follows the identity choice; a row without a reporter link is anonymous whatever it says', () => {
  expect(toPublicReport(row())).toMatchObject({ reporterDisplay: 'named', reporterName: 'Jane Q. Doe' });
  expect(toPublicReport(row({ reporter_display: 'initials' }))).toMatchObject({ reporterDisplay: 'initials', reporterName: 'J.D.' });
  expect(toPublicReport(row({ reporter_display: 'anonymous', reporter_id: null, reporter_display_name: null }))).toMatchObject({ reporterDisplay: 'anonymous', reporterName: null });
  expect(toPublicReport(row({ reporter_id: null }))).toMatchObject({ reporterDisplay: 'anonymous', reporterName: null });
  expect(toPublicReport(row({ reporter_display: 'initials', reporter_display_name: null })).reporterName).toBeNull();
  expect(initials('madonna')).toBe('M.');
  expect(initials('  ')).toBeNull();
});

test('severity shown is the effective band: resident 4 shows as 3 until a human confirms', () => {
  expect(toPublicReport(row())).toMatchObject({ severity: 3, severityConfirmed: false, emergencyRequested: true });
  expect(toPublicReport(row({ severity_ai: 2 }))).toMatchObject({ severity: 2, severityConfirmed: false });
  expect(toPublicReport(row({ severity_ai: 2, severity_confirmed: 4 }))).toMatchObject({ severity: 4, severityConfirmed: true });
  expect(toPublicReport(row({ severity_resident: null }))).toMatchObject({ severity: 2 });
  expect(toPublicReport(row()).title).toBe('Uneven sidewalk (lip or step)');
});
