/**
 * Demo scenarios — calm / storm / verify (plan §9.5; sibling demo pattern). Everything here is labelled demo
 * (isDemo: true) and deterministic: the same scenario, centre and clock always yield the same 12 reports,
 * seeded by fnv1a. Titles are adapted from the spec's prototype mock data (lines 2589–2685) and placed on
 * New Brunswick, NJ streets around the pilot centre; scores come from score.ts and SLA states from sla.ts,
 * never from the prototype's placeholder figures. Pure module: no React Native or Expo imports —
 * services/demo.ts applies the clock offset and injects the reports into the store.
 */
import { fnv1a, metresPerDegree, type LatLng } from './geo';
import { PILOT } from './pilot';
import { computeScore, effectiveSeverity, stormMultiplierFor, type ActiveScenario, type ExposureFlags } from './score';
import { slaState } from './sla';
import { subtypeDef, type StormSensitivity, type Subtype } from './taxonomy';
import { DAY_MS, localMinutes, nowMs } from './time';
import type { DemoScenario, InjuryFlag, PublicReport, ReportEvent, ReportStatus, ReporterDisplay, SeverityBand } from './types';

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface DemoScenarioDef {
  label: string;
  blurb: string;
  /**
   * Offset for the app clock while the scenario runs (Settings.demoClockOffsetMs). Computed when read, so it
   * lands on the scenario's time of day on the day the scenario is applied (sibling pattern: offsets are relative to today).
   */
  readonly clockOffsetMs: number;
  /** Active weather scenario, if any: open orders sensitive to `kind` get the multiplier. */
  storm: { kind: StormSensitivity; multiplier: number; onsetMinutes: number } | null;
  /** Advisory shown in the alerts inbox while the scenario runs — names a place and an action (plan §13). */
  alertTitle?: string;
  alertBody?: string;
}

/** Local time of day each scenario is shown at (minutes from midnight, America/New_York); null = real time. */
export const SCENARIO_CLOCK: Record<DemoScenario, number | null> = {
  calm: null,
  storm: 17 * 60 + 30, // 5:30 PM — advisories go out 4 h before the 9:30 PM onset (spec §4.2 line 2246)
  verify: 9 * 60 + 30, // 9:30 AM — the morning after the crew finished
};

/** Clock offset (ms) that makes the app clock read the scenario's time of day on today's local date. */
export function clockOffsetFor(scenario: DemoScenario, realNow: number = Date.now()): number {
  const minutes = SCENARIO_CLOCK[scenario];
  if (minutes == null) return 0;
  return (minutes - localMinutes(realNow)) * MIN_MS;
}

export const DEMO_SCENARIOS = {
  calm: {
    label: 'Calm day',
    blurb: 'Real time · the ordinary backlog, no weather scenario active',
    get clockOffsetMs() { return clockOffsetFor('calm'); },
    storm: null,
  },
  storm: {
    label: 'Storm tonight',
    blurb: '5:30 PM · 52 mm of rain from 9:30 PM — rain-sensitive orders boosted ×1.4',
    get clockOffsetMs() { return clockOffsetFor('storm'); },
    storm: { kind: 'rain', multiplier: 1.4, onsetMinutes: 21 * 60 + 30 }, // spec: §7 line 2354 — multiplier within 1.0–1.6
    alertTitle: 'Heavy rain from 9:30 PM — 52 mm overnight',
    alertBody: 'Crews are clearing the George St & Bayard St tree-pit drain and cold-patching Hamilton St before the storm. The Sandford St bus stop ponds after dark — use the Baldwin St side. Report new standing water from the Map tab.',
  },
  verify: {
    label: 'Verify a fix',
    blurb: '9:30 AM · the Livingston Ave root heave was fixed two days ago and waits for a resident to confirm',
    get clockOffsetMs() { return clockOffsetFor('verify'); },
    storm: null,
  },
} as const satisfies Record<DemoScenario, DemoScenarioDef>;

interface DemoSeed {
  /** Work-order sequence from the spec mock data (WO-2026-xxxx). */
  seq: number;
  subtype: Subtype;
  title: string;
  address: string;
  status: ReportStatus;
  resident: SeverityBand;
  confirmed: SeverityBand | null;
  ageDays: number;
  votes: number;
  pedsPerDay: number;
  flags?: ExposureFlags;
  injury: InjuryFlag;
  priorNoticeDays?: number;
  display: ReporterDisplay;
  reporterName: string | null;
  comments: number;
}

/** Spec mock rows (lines 2589–2685) relocated to New Brunswick streets. Exposure figures are the spec's. */
const SEEDS: readonly DemoSeed[] = [
  { seq: 418, subtype: 'root_heave', title: 'Root heave — 32 mm sidewalk lip', address: '118 Livingston Ave', status: 'scheduled', resident: 3, confirmed: 3, ageDays: 112, votes: 41, pedsPerDay: 1240, flags: { schoolRoute: true }, injury: 'injury', display: 'initials', reporterName: 'M. T.', comments: 6 },
  { seq: 559, subtype: 'pothole_cluster', title: 'Pothole cluster along three blocks (11 open)', address: 'Hamilton St, 200–400 block', status: 'assessed', resident: 3, confirmed: 4, ageDays: 174, votes: 63, pedsPerDay: 8600, flags: { transitStop: true }, injury: 'no', priorNoticeDays: 174, display: 'anonymous', reporterName: null, comments: 14 },
  { seq: 642, subtype: 'blocked_tree_pit_drain', title: 'Leaf-blocked tree-pit drain', address: 'George St & Bayard St', status: 'triaged', resident: 2, confirmed: null, ageDays: 38, votes: 19, pedsPerDay: 2100, flags: { transitStop: true }, injury: 'no', display: 'named', reporterName: 'Devon P.', comments: 3 },
  { seq: 771, subtype: 'hanging_limb', title: 'Cracked co-dominant limb over sidewalk', address: '52 Easton Ave', status: 'assessed', resident: 3, confirmed: 4, ageDays: 61, votes: 28, pedsPerDay: 980, injury: 'near_miss', display: 'initials', reporterName: 'R. K.', comments: 5 },
  { seq: 688, subtype: 'sightline_obstruction', title: 'Shrub blocking stop-sign sight line', address: 'Suydam St & Remsen Ave', status: 'triaged', resident: 3, confirmed: null, ageDays: 24, votes: 34, pedsPerDay: 3400, flags: { schoolRoute: true }, injury: 'near_miss', display: 'named', reporterName: 'Alicia M.', comments: 4 },
  { seq: 805, subtype: 'toxic_plant', title: 'Poison ivy along the river path (400 m)', address: 'Buccleuch Park, river path', status: 'scheduled', resident: 2, confirmed: 2, ageDays: 19, votes: 17, pedsPerDay: 640, injury: 'no', display: 'anonymous', reporterName: null, comments: 9 },
  { seq: 344, subtype: 'lamp_out', title: 'Three lamps out on underpass approach', address: 'French St rail underpass', status: 'assessed', resident: 3, confirmed: 3, ageDays: 88, votes: 47, pedsPerDay: 4200, flags: { transitStop: true }, injury: 'no', display: 'named', reporterName: 'Jordan L.', comments: 7 },
  { seq: 501, subtype: 'cracked_panels', title: 'Spalled panels outside senior centre', address: '88 Somerset St', status: 'triaged', resident: 3, confirmed: null, ageDays: 143, votes: 12, pedsPerDay: 1900, flags: { seniorFacility: true }, injury: 'no', display: 'initials', reporterName: 'H. G.', comments: 2 },
  { seq: 455, subtype: 'faded_crosswalk', title: 'Crosswalk markings gone at school crossing', address: 'Redmond St & Comstock St', status: 'scheduled', resident: 2, confirmed: 2, ageDays: 67, votes: 56, pedsPerDay: 5100, flags: { schoolRoute: true }, injury: 'no', display: 'named', reporterName: 'Priya N.', comments: 8 },
  { seq: 290, subtype: 'ponding', title: 'Chronic ponding at bus stop', address: 'Sandford St & Baldwin St', status: 'new', resident: 2, confirmed: null, ageDays: 210, votes: 9, pedsPerDay: 3800, flags: { transitStop: true }, injury: 'no', display: 'anonymous', reporterName: null, comments: 1 },
  { seq: 733, subtype: 'dead_tree', title: 'Dead ash — whole-tree failure risk', address: '40 Townsend St', status: 'assessed', resident: 3, confirmed: 4, ageDays: 52, votes: 31, pedsPerDay: 520, injury: 'no', display: 'initials', reporterName: 'S. O.', comments: 3 },
  { seq: 620, subtype: 'missing_curb_ramp', title: 'No curb ramp at signalised corner', address: 'Albany St & Neilson St', status: 'triaged', resident: 3, confirmed: null, ageDays: 301, votes: 38, pedsPerDay: 2600, flags: { transitStop: true }, injury: 'no', priorNoticeDays: 301, display: 'named', reporterName: 'Tomás R.', comments: 11 },
];

/** The report the `verify` scenario puts in `completed`, awaiting the resident's confirmation. */
export const VERIFY_SEQ = 418;

export const demoReportId = (seq: number): string => `demo-wo-${String(seq).padStart(4, '0')}`;

/** Statuses passed through on the way to each status (status.ts machine). */
const PATH: Record<ReportStatus, readonly ReportStatus[]> = {
  new: [],
  triaged: ['triaged'],
  assessed: ['triaged', 'assessed'],
  mitigated: ['triaged', 'assessed', 'mitigated'],
  scheduled: ['triaged', 'assessed', 'scheduled'],
  completed: ['triaged', 'assessed', 'scheduled', 'completed'],
  verified: ['triaged', 'assessed', 'scheduled', 'completed', 'verified'],
  rejected: ['triaged', 'rejected'],
};

/** Days after creation each stage happened in the demo stories; completed/verified count back from "now". */
const STAGE_DAY: Partial<Record<ReportStatus, number>> = { triaged: 1, assessed: 5, mitigated: 6, scheduled: 10, rejected: 2 };

function stageAt(stage: ReportStatus, createdAt: number, now: number): number {
  if (stage === 'completed') return now - 2 * DAY_MS;
  if (stage === 'verified') return now - DAY_MS;
  return Math.min(now, createdAt + (STAGE_DAY[stage] ?? 0) * DAY_MS);
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Deterministic point 150–1200 m from the centre, seeded by the report id. */
function place(center: LatLng, seed: string): LatLng {
  const h = fnv1a(seed);
  const angle = ((h & 0xffff) / 0xffff) * 2 * Math.PI;
  const dist = 150 + ((h >>> 16) / 0xffff) * 1050;
  const m = metresPerDegree(center.lat);
  return { lat: round6(center.lat + (Math.sin(angle) * dist) / m.lat), lng: round6(center.lng + (Math.cos(angle) * dist) / m.lng) };
}

function buildReport(seed: DemoSeed, scenario: DemoScenario, center: LatLng, now: number, active: ActiveScenario | null): PublicReport {
  const id = demoReportId(seed.seq);
  const h = fnv1a(`demo:${seed.seq}`);
  const status: ReportStatus = scenario === 'verify' && seed.seq === VERIFY_SEQ ? 'completed' : seed.status;
  const createdAt = now - seed.ageDays * DAY_MS - (h % 1440) * MIN_MS;
  const def = subtypeDef(seed.subtype);
  const severity = effectiveSeverity({ confirmed: seed.confirmed, ai: null, resident: seed.resident });

  const timeline: ReportEvent[] = [{ id: `${id}-e0`, kind: 'created', fromStatus: null, toStatus: 'new', note: null, at: new Date(createdAt).toISOString() }];
  let from: ReportStatus = 'new';
  const stampOf: Partial<Record<ReportStatus, number>> = {};
  PATH[status].forEach((to, i) => {
    const at = stageAt(to, createdAt, now);
    stampOf[to] = at;
    timeline.push({ id: `${id}-e${i + 1}`, kind: 'status', fromStatus: from, toStatus: to, note: to === 'completed' ? 'After-photo attached — please confirm the fix' : null, at: new Date(at).toISOString() });
    from = to;
  });

  const activeUsers = 80 + (h % 180);
  const voteWeightSum = Math.round(seed.votes * (0.85 + ((h >>> 8) % 15) / 100) * 10) / 10;
  const { score, terms, stormMultiplier } = computeScore({
    severity,
    pedsPerDay: seed.pedsPerDay,
    exposureFlags: seed.flags,
    voteWeightSum,
    activeUsers,
    adaFlag: def.adaRelevant,
    injuryFlag: seed.injury,
    priorNoticeDays: seed.priorNoticeDays ?? 0,
    daysOpen: seed.ageDays,
    stormMultiplier: stormMultiplierFor(def.sensitivity, active, now),
  });

  const point = place(center, id);
  const last = timeline[timeline.length - 1]!;
  return {
    id,
    category: def.category,
    subtype: seed.subtype,
    status,
    title: seed.title,
    addressText: seed.address,
    addressConfidence: 'approx',
    lat: point.lat,
    lng: point.lng,
    severity,
    severityConfirmed: seed.confirmed != null,
    emergencyRequested: false,
    score,
    scoreTerms: terms,
    stormMultiplier,
    voteCount: seed.votes,
    createdAt: timeline[0]!.at,
    updatedAt: last.at,
    reporterDisplay: seed.display,
    reporterName: seed.display === 'anonymous' ? null : seed.reporterName,
    stormSensitivity: [...def.sensitivity],
    photos: [],
    timeline,
    commentCount: seed.comments,
    slaState: slaState({ severity, status, createdAt, firstAckAt: stampOf.triaged, assessedAt: stampOf.assessed, mitigatedAt: stampOf.mitigated, completedAt: stampOf.completed }, now),
    isDemo: true,
  };
}

/** 12 labelled demo reports around `center`, deterministic for a given scenario, centre and clock. */
export function buildDemoReports(scenario: DemoScenario, center: LatLng = PILOT.center, now: number = nowMs()): PublicReport[] {
  const storm = DEMO_SCENARIOS[scenario].storm;
  const active: ActiveScenario | null = storm ? { kind: storm.kind, multiplier: storm.multiplier, startsAt: now - HOUR_MS, endsAt: now + DAY_MS } : null;
  return SEEDS.map((seed) => buildReport(seed, scenario, center, now, active));
}
