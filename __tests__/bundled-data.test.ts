/**
 * Taxonomy integrity: the fixed hazard list the whole system agrees on (phone picker, API enums, SQL enums).
 * Every category has sub-types, labels are unique and human, tags are valid, and the duplicate radius rule holds.
 */
import { CATEGORIES, CATEGORY_LABEL, DUP_RADIUS_M, STORM_SENSITIVITIES, SUBTYPES, SUBTYPE_IDS, defaultSubtype, dupRadiusM, subtypesOf } from '@/domain/taxonomy';
import { CreateReportInputSchema, PublicReportSchema, REPORT_STATUSES } from '@/domain/types';

describe('taxonomy', () => {
  test('every category has at least one sub-type and a label', () => {
    for (const c of CATEGORIES) {
      expect(subtypesOf(c).length).toBeGreaterThan(0);
      expect(CATEGORY_LABEL[c].length).toBeGreaterThan(0);
      expect(SUBTYPES[defaultSubtype(c)].category).toBe(c);
    }
  });

  test('sub-type ids are snake_case, labels unique, tags valid', () => {
    const labels = new Set<string>();
    for (const id of SUBTYPE_IDS) {
      expect(id).toMatch(/^[a-z][a-z0-9_]+$/);
      const def = SUBTYPES[id];
      expect(labels.has(def.label)).toBe(false);
      labels.add(def.label);
      for (const tag of def.sensitivity) expect(STORM_SENSITIVITIES).toContain(tag);
      expect(CATEGORIES).toContain(def.category);
    }
  });

  test('duplicate radius: 25 m for point features, 60 m for linear ones (spec 4.1, §8)', () => {
    expect(DUP_RADIUS_M).toEqual({ point: 25, linear: 60 });
    expect(dupRadiusM('root_heave')).toBe(25);
    expect(dupRadiusM('toxic_plant')).toBe(60);
    expect(dupRadiusM('pothole_cluster')).toBe(60);
  });

  test('ADA relevance is set on sidewalk-type defects only', () => {
    const ada = SUBTYPE_IDS.filter((id) => SUBTYPES[id].adaRelevant);
    expect(ada.sort()).toEqual(['cracked_panels', 'missing_curb_ramp', 'root_heave', 'uneven_sidewalk']);
  });

  test('status list matches the spec mapping table (8 statuses, in order)', () => {
    expect(REPORT_STATUSES).toEqual(['new', 'triaged', 'assessed', 'mitigated', 'scheduled', 'completed', 'verified', 'rejected']);
  });

  test('schemas reject unknown categories and accept a valid create payload', () => {
    expect(CreateReportInputSchema.safeParse({ clientDraftId: 'd_abcdefgh', category: 'parking', subtype: 'pothole', severityResident: 2, injuryFlag: 'no', reporterDisplay: 'named', lat: 40.5, lng: -74.45, accuracyM: 8, locationConfirmed: true, photoIds: [], capturedAt: '2026-10-05T12:00:00.000Z' }).success).toBe(false);
    expect(CreateReportInputSchema.safeParse({ clientDraftId: 'd_abcdefgh', category: 'roadway', subtype: 'pothole', severityResident: 2, injuryFlag: 'no', reporterDisplay: 'named', lat: 40.5, lng: -74.45, accuracyM: 8, locationConfirmed: true, photoIds: [], capturedAt: '2026-10-05T12:00:00.000Z' }).success).toBe(true);
    expect(PublicReportSchema.safeParse({}).success).toBe(false);
  });
});
