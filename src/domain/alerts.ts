/**
 * Predictive alerts — the rules and the words (spec §9 "Alert engine": trigger_expr, audience selection, anti-fatigue
 * rules; §4.2 predictive alert flow; R9 briefing; plan §8 scenario.ts / audience.ts, §23.H). Pure module: no React
 * Native or Expo imports. The server job (src/server/jobs/scenarioEval.ts) and the phone's storm demo build their
 * briefings with the same template here, so a resident reads the same shape in the demo and on the night it is real.
 * Every alert names a place, a behaviour change and what the city is doing (spec §9 "non-negotiable").
 */
import { DEMO_SCENARIOS } from './demo';
import { isOpen } from './status';
import { subtypeDef, type StormSensitivity } from './taxonomy';
import { DAY_MS, daysBetween, formatTime, localMinutes } from './time';
import type { AlertBody, AlertItem, AlertSpot, PublicReport } from './types';

// ---------- Constants ----------

export const AUDIENCE_BUFFER_M = 400; // spec: §9 "ST_DWithin(watch_area.geom, hazard_buffer)"; the pilot's home radius (R14 "Home · 400m")
export const FATIGUE_BUDGET = 2; // spec: §9 "resident_alert": {"fatigue_budget": 2}; "Max 2 predictive alerts per resident per week"
export const FATIGUE_WINDOW_MS = 7 * DAY_MS; // spec: §9 "fatigue_used(user, 7d)"
export const ALERT_SPOTS_MAX = 5; // R9 lists "the spots"; the briefing stays readable on one screen
/** A scenario that fired is not evaluated again for this long (plan §3.7: one run per storm, not one per poll). */
export const SCENARIO_COOLDOWN_MS = 12 * 3_600_000;
/** A run keeps its storm multiplier active for this long after it fired (spec §7: the boost ends with the window). */
export const RUN_ACTIVE_MS = DAY_MS;
export const DEMO_STORM_ALERT_ID = 'demo-storm';

// ---------- Scenario rules (spec §9 trigger_expr shape; §7 storm_multiplier 1.0–1.6) ----------

/** What one weather_forecast row says; null = the source did not give that field (an honest gap, never a 0). */
export interface ForecastFacts {
  rainMm6h: number | null;
  popPct: number | null;
  gustKmh: number | null;
  tempMinC: number | null;
  tempMaxC: number | null;
}

/** One open report as the rule sees it (spec §9 "asset.tag" → report.storm_sensitivity, plan §3.7). */
export interface ReportFacts {
  category: string;
  open_days: number;
  tags: readonly string[];
}

export interface Comparison {
  gte?: number;
  gt?: number;
  lte?: number;
  lt?: number;
  eq?: number | string;
}

/**
 * scenario.trigger_expr (spec §9 example): {all: [...]} / {any: [...]} nodes over leaves such as
 * {"forecast.rain_mm_6h": {"gte": 35}}, {"forecast.confidence": {"gte": 0.6}}, {"asset.tag": "rain"},
 * {"report.category": "roadway", "report.open_days": {"gte": 30}}. A leaf with several fields is an implicit all.
 */
export type TriggerExpr = { all: TriggerExpr[] } | { any: TriggerExpr[] } | Record<string, Comparison | number | string>;

export interface TriggerFacts {
  forecast: ForecastFacts;
  report?: ReportFacts;
}

function factValue(field: string, facts: TriggerFacts): number | string | readonly string[] | null {
  switch (field) {
    case 'forecast.rain_mm_6h':
      return facts.forecast.rainMm6h;
    case 'forecast.confidence':
      return facts.forecast.popPct === null ? null : facts.forecast.popPct / 100;
    case 'forecast.pop_pct':
      return facts.forecast.popPct;
    case 'forecast.gust_kmh':
      return facts.forecast.gustKmh;
    case 'forecast.temp_min_c':
      return facts.forecast.tempMinC;
    case 'forecast.temp_max_c':
      return facts.forecast.tempMaxC;
    case 'asset.tag':
      return facts.report?.tags ?? null;
    case 'report.category':
      return facts.report?.category ?? null;
    case 'report.open_days':
      return facts.report?.open_days ?? null;
    default:
      return null;
  }
}

function compare(value: number | string | readonly string[] | null, cmp: Comparison | number | string): boolean {
  if (value === null) return false; // a missing fact never fires a rule
  if (typeof cmp === 'number' || typeof cmp === 'string') return Array.isArray(value) ? (value as readonly string[]).includes(String(cmp)) : value === cmp;
  if (Array.isArray(value)) return cmp.eq !== undefined && (value as readonly string[]).includes(String(cmp.eq));
  if (typeof value === 'string') return cmp.eq === undefined ? false : value === cmp.eq;
  const n = value as number;
  if (cmp.eq !== undefined && n !== cmp.eq) return false;
  if (cmp.gte !== undefined && !(n >= cmp.gte)) return false;
  if (cmp.gt !== undefined && !(n > cmp.gt)) return false;
  if (cmp.lte !== undefined && !(n <= cmp.lte)) return false;
  if (cmp.lt !== undefined && !(n < cmp.lt)) return false;
  return true;
}

/** True when the rule holds for these facts. Unknown fields and malformed nodes are false, never a throw. */
export function evaluateTrigger(expr: unknown, facts: TriggerFacts): boolean {
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return false;
  const node = expr as Record<string, unknown>;
  if (Array.isArray(node.all)) return node.all.length > 0 && node.all.every((child) => evaluateTrigger(child, facts));
  if (Array.isArray(node.any)) return node.any.some((child) => evaluateTrigger(child, facts));
  const leaves = Object.entries(node);
  if (leaves.length === 0) return false;
  return leaves.every(([field, cmp]) => {
    if (cmp === null || cmp === undefined || Array.isArray(cmp) || (typeof cmp === 'object' && Object.keys(cmp as object).length === 0)) return false;
    return compare(factValue(field, facts), cmp as Comparison | number | string);
  });
}

export interface ScenarioDefault {
  name: string;
  kind: StormSensitivity;
  trigger_expr: TriggerExpr;
  action_thresholds: Record<string, unknown>;
  storm_multiplier: number;
}

/** Seeded when the scenario table is empty (spec §9 example thresholds; §7 multiplier 1.0–1.6; demo storm ×1.4). */
export const DEFAULT_SCENARIOS: readonly ScenarioDefault[] = [
  {
    name: 'Heavy rain',
    kind: 'rain',
    trigger_expr: { all: [{ 'forecast.rain_mm_6h': { gte: 35 } }, { 'forecast.confidence': { gte: 0.6 } }, { 'asset.tag': 'rain' }] }, // spec: §9 trigger_expr example (rain ≥ 35 mm / 6 h, confidence ≥ 0.6)
    action_thresholds: { resident_alert: { p_min: 0.3, fatigue_budget: FATIGUE_BUDGET } }, // spec: §9 action_thresholds "resident_alert"
    storm_multiplier: 1.4, // spec: §7 line 2354 — within 1.0–1.6; the same figure as the storm demo
  },
  {
    name: 'High wind',
    kind: 'wind',
    trigger_expr: { all: [{ 'forecast.gust_kmh': { gte: 60 } }, { 'asset.tag': 'wind' }] }, // plan §3.7: gusts drive the wind scenario; 60 km/h is a pilot default
    action_thresholds: { resident_alert: { p_min: 0.3, fatigue_budget: FATIGUE_BUDGET } },
    storm_multiplier: 1.3,
  },
  {
    name: 'Freeze–thaw',
    kind: 'freeze',
    trigger_expr: { all: [{ 'forecast.temp_min_c': { lte: -2 } }, { 'forecast.temp_max_c': { gte: 2 } }, { 'asset.tag': 'freeze' }] }, // spec 4.2 "freeze-thaw cycles"; pilot default thresholds
    action_thresholds: { resident_alert: { p_min: 0.3, fatigue_budget: FATIGUE_BUDGET } },
    storm_multiplier: 1.2,
  },
];

/** advisory or warning from the scenario's weight and the forecast's confidence; emergency is only ever set by a person. */
export function alertSeverity(multiplier: number, popPct: number | null): AlertBody['kind'] {
  return multiplier >= 1.4 || (popPct ?? 0) >= 80 ? 'warning' : 'advisory';
}

// ---------- Copy (spec §9: a specific place, a specific behaviour change, what the city is doing) ----------

export interface SpotInput {
  reportId: string;
  title: string;
  address: string;
  subtype: PublicReport['subtype'];
  createdAt: string;
  distanceM?: number | null;
}

export interface AlertCopyInput {
  kind: StormSensitivity;
  severity: AlertBody['kind'];
  forecast: AlertBody['forecast'];
  validFrom: string | null;
  validTo: string | null;
  /** Matched open hazards, highest score first; the first ALERT_SPOTS_MAX become the spots. */
  spots: readonly SpotInput[];
  /** All matched hazards (the DPW work list), not only the listed spots. */
  hazardCount: number;
  bufferM?: number;
  now: number;
}

const WEATHER_NOUN: Record<StormSensitivity, string> = { rain: 'rain', wind: 'wind', freeze: 'freeze–thaw' };

function joinPlaces(places: readonly string[]): string {
  const p = places.filter((s) => s.trim().length > 0).slice(0, 3);
  if (p.length === 0) return 'the spots listed below';
  if (p.length === 1) return p[0];
  return `${p.slice(0, -1).join(', ')} and ${p[p.length - 1]}`;
}

function headline(input: AlertCopyInput): string {
  const f = input.forecast;
  const from = input.validFrom ? ` from ${formatTime(input.validFrom)}` : '';
  switch (input.kind) {
    case 'rain':
      return `Heavy rain${from}${f?.rainMm6h != null ? ` — ${Math.round(f.rainMm6h)} mm` : ''}`;
    case 'wind':
      return `High wind${from}${f?.gustKmh != null ? ` — gusts to ${Math.round(f.gustKmh)} km/h` : ''}`;
    default:
      return `Freeze–thaw${from}${f?.tempMinC != null ? ` — low ${Math.round(f.tempMinC)} °C` : ''}`;
  }
}

/** The behaviour change (spec §9: never "be careful out there"). */
function behaviour(kind: StormSensitivity, places: string): string {
  switch (kind) {
    case 'rain':
      return `Expect standing water at ${places} after dark. Take the other side of the street there and report new ponding from the Map tab.`;
    case 'wind':
      return `Limbs over the walkway at ${places} can come down in these gusts. Keep clear of those trees until a crew has checked them.`;
    default:
      return `Ice forms on the lips and panels at ${places} overnight. Step wide there and report new ice from the Map tab.`;
  }
}

/** "<address> · <days> days open · <subtype label>" — one line of plain facts per spot. */
export function spotLine(spot: SpotInput, now: number): string {
  const days = daysBetween(spot.createdAt, now);
  return `${spot.address.trim() || 'near you'} · ${days} ${days === 1 ? 'day' : 'days'} open · ${subtypeDef(spot.subtype).label}`;
}

export function buildAlertBody(input: AlertCopyInput): AlertBody {
  const bufferM = input.bufferM ?? AUDIENCE_BUFFER_M;
  const spots: AlertSpot[] = input.spots.slice(0, ALERT_SPOTS_MAX).map((s) => ({ reportId: s.reportId, title: s.title, line: spotLine(s, input.now), distanceM: s.distanceM ?? null }));
  const n = input.hazardCount;
  const noun = WEATHER_NOUN[input.kind];
  const hazards = `${n} open ${n === 1 ? 'hazard' : 'hazards'}`;
  return {
    kind: input.severity,
    trigger: input.kind,
    title: `${headline(input)} · ${hazards} sensitive to ${noun}`,
    body: behaviour(
      input.kind,
      joinPlaces(input.spots.map((s) => s.address)),
    ),
    why: `Your watch area is within ${bufferM} m of one or more of the ${hazards} sensitive to ${noun}. This is the open backlog matched against the forecast by a published rule — not a prediction of where damage will happen.`,
    spots,
    cityAction: 'The same list went to DPW as a pre-storm work list.',
    validFrom: input.validFrom,
    validTo: input.validTo,
    forecast: input.forecast,
  };
}

// ---------- The storm demo (plan §9.5): the same template over the labelled demo reports ----------

/** The storm demo's forecast facts (spec R9 mock: 52 mm, confidence 84 %; DEMO_SCENARIOS.storm blurb). */
export const DEMO_STORM_FORECAST = { rainMm6h: 52, popPct: 84, gustKmh: 40, tempMinC: null } as const;

/** Tonight's onset on the app clock (DEMO_SCENARIOS.storm.onsetMinutes), as an ISO window [onset, onset + 6 h). */
export function demoStormWindow(now: number): { validFrom: string; validTo: string } {
  const onset = DEMO_SCENARIOS.storm.storm.onsetMinutes;
  const from = now + (onset - localMinutes(now)) * 60_000;
  return { validFrom: new Date(from).toISOString(), validTo: new Date(from + 6 * 3_600_000).toISOString() };
}

/** Open demo reports sensitive to rain, highest score first — what the storm advisory is about. */
export function demoStormSpots(reports: readonly PublicReport[]): PublicReport[] {
  return reports
    .filter((r) => r.isDemo && isOpen(r.status) && r.stormSensitivity.includes('rain'))
    .slice()
    .sort((a, b) => b.score - a.score);
}

/** The storm demo's briefing: title and body from the scenario, the rest from the shared template. */
export function demoStormBriefing(reports: readonly PublicReport[], now: number): AlertBody {
  const storm = DEMO_SCENARIOS.storm;
  const spots = demoStormSpots(reports);
  const window = demoStormWindow(now);
  const body = buildAlertBody({
    kind: 'rain',
    severity: 'warning',
    forecast: { source: 'Demo forecast — an archived storm shifted to tonight', issuedAt: new Date(now).toISOString(), ...DEMO_STORM_FORECAST },
    validFrom: window.validFrom,
    validTo: window.validTo,
    spots: spots.map((r) => ({ reportId: r.id, title: r.title, address: r.addressText, subtype: r.subtype, createdAt: r.createdAt })),
    hazardCount: spots.length,
    now,
  });
  return { ...body, title: storm.alertTitle, body: storm.alertBody };
}

/** The labelled inbox item the storm demo shows (S-03) and the home hero opens (S-01). */
export function demoStormAlertItem(reports: readonly PublicReport[], now: number): AlertItem {
  const briefing = demoStormBriefing(reports, now);
  return { id: DEMO_STORM_ALERT_ID, kind: briefing.kind, title: briefing.title, body: briefing.body, reportId: null, alertId: null, at: new Date(now).toISOString(), read: true, isDemo: true, briefing };
}
