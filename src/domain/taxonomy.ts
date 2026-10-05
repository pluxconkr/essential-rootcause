/**
 * Hazard taxonomy — the fixed list the resident never has to scroll through (spec 4.1: "the model proposes;
 * the human corrects"). Categories, sub-types, their weather sensitivity tags (drive storm scenarios),
 * ADA relevance (feeds the liability term) and whether the feature is linear (wider duplicate radius).
 * Pure module: no React Native or Expo imports. Shared by the app, the API routes and the tests.
 */

export const CATEGORIES = ['vegetation', 'roadway', 'sidewalk', 'drainage', 'lighting'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Tags that storm scenarios match against (spec §9 `asset.tag` → report.storm_sensitivity). */
export const STORM_SENSITIVITIES = ['rain', 'wind', 'freeze'] as const;
export type StormSensitivity = (typeof STORM_SENSITIVITIES)[number];

export interface SubtypeDef {
  category: Category;
  /** Resident-facing label (spec R5 sub-type picker wording). */
  label: string;
  sensitivity: readonly StormSensitivity[];
  /** True when a confirmed defect of this kind triggers the ADA threshold logic (spec R4 ADA flag). */
  adaRelevant: boolean;
  /** Linear features (a trail edge, a block of potholes) use the wider duplicate radius. */
  linear: boolean;
}

export const SUBTYPES = {
  root_heave: { category: 'vegetation', label: 'Tree root heaving sidewalk (trip hazard)', sensitivity: ['rain', 'freeze'], adaRelevant: true, linear: false },
  hanging_limb: { category: 'vegetation', label: 'Hanging or cracked limb over walkway', sensitivity: ['wind'], adaRelevant: false, linear: false },
  dead_tree: { category: 'vegetation', label: 'Dead or declining tree', sensitivity: ['wind'], adaRelevant: false, linear: false },
  sightline_obstruction: { category: 'vegetation', label: 'Sight-line obstruction at intersection', sensitivity: [], adaRelevant: false, linear: false },
  toxic_plant: { category: 'vegetation', label: 'Invasive or toxic plant (poison ivy, hogweed)', sensitivity: [], adaRelevant: false, linear: true },
  blocked_tree_pit_drain: { category: 'vegetation', label: 'Blocked tree-pit drain', sensitivity: ['rain'], adaRelevant: false, linear: false },
  storm_debris: { category: 'vegetation', label: 'Storm debris on walkway', sensitivity: [], adaRelevant: false, linear: false },
  allergenic_weed: { category: 'vegetation', label: 'Allergenic weed stand (ragweed)', sensitivity: [], adaRelevant: false, linear: false },
  pothole: { category: 'roadway', label: 'Pothole', sensitivity: ['rain', 'freeze'], adaRelevant: false, linear: false },
  pothole_cluster: { category: 'roadway', label: 'Pothole cluster along a block', sensitivity: ['rain', 'freeze'], adaRelevant: false, linear: true },
  faded_crosswalk: { category: 'roadway', label: 'Faded crosswalk markings', sensitivity: [], adaRelevant: false, linear: false },
  cracked_panels: { category: 'sidewalk', label: 'Cracked or spalled sidewalk panels', sensitivity: ['freeze'], adaRelevant: true, linear: false },
  uneven_sidewalk: { category: 'sidewalk', label: 'Uneven sidewalk (lip or step)', sensitivity: ['rain', 'freeze'], adaRelevant: true, linear: false },
  missing_curb_ramp: { category: 'sidewalk', label: 'Missing or broken curb ramp', sensitivity: [], adaRelevant: true, linear: false },
  ponding: { category: 'drainage', label: 'Standing water / chronic ponding', sensitivity: ['rain', 'freeze'], adaRelevant: false, linear: false },
  blocked_drain: { category: 'drainage', label: 'Blocked storm drain', sensitivity: ['rain'], adaRelevant: false, linear: false },
  lamp_out: { category: 'lighting', label: 'Street light out / dark walkway', sensitivity: [], adaRelevant: false, linear: false },
} as const satisfies Record<string, SubtypeDef>;

export type Subtype = keyof typeof SUBTYPES;
export const SUBTYPE_IDS = Object.keys(SUBTYPES) as [Subtype, ...Subtype[]];

export function subtypeDef(id: Subtype): SubtypeDef {
  return SUBTYPES[id];
}

export function subtypesOf(category: Category): Subtype[] {
  return SUBTYPE_IDS.filter((id) => SUBTYPES[id].category === category);
}

/** The first sub-type of a category, used when the resident picks only a category. */
export function defaultSubtype(category: Category): Subtype {
  return subtypesOf(category)[0];
}

/** Duplicate search radius in metres (spec 4.1: "within 25m"; spec §8: per-category radius, linear features differ). */
export const DUP_RADIUS_M = { point: 25, linear: 60 } as const;

export function dupRadiusM(subtype: Subtype): number {
  return SUBTYPES[subtype].linear ? DUP_RADIUS_M.linear : DUP_RADIUS_M.point;
}

export const CATEGORY_LABEL: Record<Category, string> = {
  vegetation: 'Vegetation',
  roadway: 'Roadway',
  sidewalk: 'Sidewalk',
  drainage: 'Drainage',
  lighting: 'Lighting',
};
