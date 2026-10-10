/**
 * scenarioEval (plan §11; spec 4.2 steps 1–6, §9 alert engine): after each weather poll, every enabled scenario row is
 * evaluated against the latest forecast and the open backlog — open reports whose storm_sensitivity carries the
 * scenario's kind, each checked with src/domain/alerts.ts evaluateTrigger() over the spec-shaped trigger_expr. When a
 * scenario fires and has no run in the last SCENARIO_COOLDOWN_MS: the audience is computed with the audience_for_hazards
 * RPC (watch area ∩ hazard buffer), thinned by the fatigue budget (plan §23.H: < 2 distinct non-emergency alerts by
 * push/sms per 7 d) and quiet hours (unless emergency), then one scenario_run (the DPW work list), one alert (the
 * AlertBody briefing, forecast snapshot, hazard ids) and alert_delivery rows are written: inbox for everyone, push for
 * accounts with a device. alertDispatch sends the push rows; the inbox rows are delivered when the phone fetches them.
 * The briefing's window is the storm's, not the poll's: stormWindow() reads the peak 6 h of the stored hourly rain
 * series (no series → no window, and the headline names no onset). A forecast polled more than FORECAST_MAX_AGE_MS
 * ago is not evaluated. No console exists in this app yet, so a rules-based run goes straight to `dispatched` (plan
 * §4 flow 8 names a supervisor approval step for O6/O11). The default scenarios are inserted when the table is empty.
 * The job is idempotent across ticks: a scenario that fired is skipped by its cooldown, so a partial run resumes safely.
 */
import { AUDIENCE_BUFFER_M, DEFAULT_SCENARIOS, FATIGUE_BUDGET, FATIGUE_WINDOW_MS, RUN_ACTIVE_MS, SCENARIO_COOLDOWN_MS, alertSeverity, buildAlertBody, evaluateTrigger, type ForecastFacts } from '@/domain/alerts';
import { clampMultiplier } from '@/domain/score';
import { subtypeDef, type StormSensitivity } from '@/domain/taxonomy';
import { daysBetween, inQuietHours } from '@/domain/time';

import { logEvent } from '../log';
import { getAlertsRepo, type AlertsRepo, type DeliveryInsert, type ForecastRow, type HazardRow, type ScenarioRow } from '../repos/alerts';
import { CHUNK_SIZE, isoAt, outOfTime, type JobContext, type JobFn } from './types';
import { RAIN_WINDOW_H, WEATHER_POLL_INTERVAL_MS, peakRainWindow } from './weatherPoll';

export const SCENARIO_EVAL_INTERVAL_MS = WEATHER_POLL_INTERVAL_MS; // runs on the tick after each poll (tick.ts JOBS order)
/** A forecast polled longer ago than this is not evaluated: the app shows last-known data, but nothing new fires from it (plan §11 "staleness badge > 60 min"). */
export const FORECAST_MAX_AGE_MS = 3 * 3_600_000;
export const FORECAST_SOURCE = 'NWS gridpoint forecast'; // what the briefing names as its source
const HOUR_MS = 3_600_000;

/** Postgres timestamps carry microseconds; Date.parse takes at most milliseconds. */
const parseTs = (iso: string): number => Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));

export interface FiredScenario {
  scenarioId: string;
  kind: StormSensitivity;
  runId: string;
  alertId: string;
  hazards: number;
  audience: number;
  deliveries: number;
}

export interface EvalOutcome {
  forecastId: string | null;
  fired: FiredScenario[];
  /** scenario id → why it did not fire. */
  skipped: Record<string, string>;
  note: string;
}

export interface EvalOptions {
  repo?: AlertsRepo;
}

export function forecastFacts(row: ForecastRow): ForecastFacts {
  return { rainMm6h: row.rain_mm, popPct: row.pop_pct, gustKmh: row.gust_kmh, tempMinC: row.temp_min, tempMaxC: row.temp_max };
}

/** Enabled scenarios; the code defaults are inserted first when the table is empty. */
export async function activeScenarios(repo: AlertsRepo): Promise<ScenarioRow[]> {
  let rows = await repo.listScenarios();
  if (rows.length === 0) rows = await repo.seedScenarios(DEFAULT_SCENARIOS);
  return rows.filter((s) => s.enabled);
}

/** The hazards the rule holds for, highest score first. */
export function matchHazards(scenario: ScenarioRow, facts: ForecastFacts, hazards: readonly HazardRow[], now: number): HazardRow[] {
  return hazards.filter((h) => evaluateTrigger(scenario.trigger_expr, { forecast: facts, report: { category: h.category, open_days: daysBetween(h.created_at, now), tags: h.storm_sensitivity } }));
}

/**
 * The window the briefing names (the storm, not the poll horizon): for rain, the peak RAIN_WINDOW_H hours of the row's
 * payload.rainMmByHour, whose bucket i starts at valid_from + i h (weatherPoll.ts toForecastRow). null when the row
 * carries no series — the headline then names no onset — and for wind and freeze, which have no onset logic yet.
 */
export function stormWindow(forecast: ForecastRow, kind: StormSensitivity): { validFrom: string; validTo: string } | null {
  if (kind !== 'rain') return null;
  const raw = forecast.payload.rainMmByHour;
  if (!Array.isArray(raw)) return null;
  const peak = peakRainWindow(raw.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)), RAIN_WINDOW_H);
  const polled = parseTs(forecast.valid_from);
  if (!peak || !Number.isFinite(polled)) return null;
  const from = polled + peak.start * HOUR_MS;
  return { validFrom: isoAt(from), validTo: isoAt(from + RAIN_WINDOW_H * HOUR_MS) };
}

/** Audience ids after the fatigue budget and quiet hours (spec §9 audience selection; emergency bypasses both). */
export async function selectAudience(repo: AlertsRepo, hazardIds: readonly string[], severity: 'advisory' | 'warning' | 'emergency', now: number): Promise<{ kept: string[]; fatigued: number; quiet: number }> {
  const candidates = await repo.audienceForHazards(hazardIds, AUDIENCE_BUFFER_M);
  if (severity === 'emergency') return { kept: candidates, fatigued: 0, quiet: 0 };
  const used = await repo.fatigueUsed(candidates, isoAt(now - FATIGUE_WINDOW_MS));
  const rested = candidates.filter((id) => (used.get(id) ?? 0) < FATIGUE_BUDGET);
  const windows = await repo.quietHoursFor(rested);
  const kept = rested.filter((id) => !inQuietHours(now, windows.get(id) ?? null));
  return { kept, fatigued: candidates.length - rested.length, quiet: rested.length - kept.length };
}

export async function evaluateScenarios(ctx: Pick<JobContext, 'now' | 'deadline' | 'requestId'>, opts: EvalOptions = {}): Promise<EvalOutcome> {
  const repo = opts.repo ?? getAlertsRepo();
  const outcome: EvalOutcome = { forecastId: null, fired: [], skipped: {}, note: '' };
  const forecast = await repo.latestForecast();
  if (!forecast) {
    outcome.note = 'no forecast stored yet';
    return outcome;
  }
  // Age counts from the poll (valid_from is the poll instant, weatherPoll.ts toForecastRow), not from issued_at: the
  // NWS publication time is routinely hours older than the poll and stays on the briefing as its "issued" line.
  const polled = parseTs(forecast.valid_from);
  if (Number.isFinite(polled) && ctx.now - polled > FORECAST_MAX_AGE_MS) {
    outcome.note = `forecast stale (${Math.round((ctx.now - polled) / 60_000)} min)`;
    return outcome;
  }
  outcome.forecastId = forecast.id;
  const facts = forecastFacts(forecast);
  const nowIso = isoAt(ctx.now);
  for (const scenario of await activeScenarios(repo)) {
    if (outOfTime(ctx)) {
      outcome.skipped[scenario.id] = 'deadline';
      continue;
    }
    if (await repo.recentRun(scenario.id, isoAt(ctx.now - SCENARIO_COOLDOWN_MS))) {
      outcome.skipped[scenario.id] = 'cooldown';
      continue;
    }
    const hazards = matchHazards(scenario, facts, await repo.openHazardsSensitiveTo(scenario.kind, CHUNK_SIZE), ctx.now);
    if (hazards.length === 0) {
      outcome.skipped[scenario.id] = 'no match';
      continue;
    }
    const worklist = hazards.map((h) => h.id);
    const severity = alertSeverity(clampMultiplier(scenario.storm_multiplier), facts.popPct);
    const audience = await selectAudience(repo, worklist, severity, ctx.now);
    const body = buildAlertBody({
      kind: scenario.kind,
      severity,
      forecast: { source: FORECAST_SOURCE, issuedAt: forecast.issued_at, rainMm6h: facts.rainMm6h, popPct: facts.popPct, gustKmh: facts.gustKmh, tempMinC: facts.tempMinC },
      ...(stormWindow(forecast, scenario.kind) ?? { validFrom: null, validTo: null }),
      spots: hazards.map((h) => ({ reportId: h.id, title: subtypeDef(h.subtype).label, address: h.address_text, subtype: h.subtype, createdAt: h.created_at })),
      hazardCount: hazards.length,
      now: ctx.now,
    });
    const run = await repo.createRun({ scenario_id: scenario.id, forecast_id: forecast.id, triggered_at: nowIso, worklist, audience_count: audience.kept.length, status: 'dispatched', outcome: null });
    const alert = await repo.createAlert({
      scenario_run_id: run.id,
      severity,
      channel_mix: { push: true, inbox: true },
      audience_query: { buffer_m: AUDIENCE_BUFFER_M, fatigue_budget: FATIGUE_BUDGET, fatigue_window_days: FATIGUE_WINDOW_MS / 86_400_000, quiet_hours: severity === 'emergency' ? 'bypassed' : 'respected', candidates: audience.kept.length + audience.fatigued + audience.quiet, fatigued: audience.fatigued, quiet: audience.quiet },
      hazard_ids: worklist,
      forecast_snapshot: { id: forecast.id, issued_at: forecast.issued_at, valid_from: forecast.valid_from, valid_to: forecast.valid_to, ...facts },
      body,
      scheduled_for: nowIso,
      sent_at: nowIso,
      created_at: nowIso,
    });
    const withDevice = new Set((await repo.devicesFor(audience.kept)).map((d) => d.user_id));
    const rows: DeliveryInsert[] = [
      ...audience.kept.map((user_id) => ({ alert_id: alert.id, user_id, channel: 'inbox' as const, created_at: nowIso })),
      ...audience.kept.filter((id) => withDevice.has(id)).map((user_id) => ({ alert_id: alert.id, user_id, channel: 'push' as const, created_at: nowIso })),
    ];
    const deliveries = await repo.insertDeliveries(rows);
    outcome.fired.push({ scenarioId: scenario.id, kind: scenario.kind, runId: run.id, alertId: alert.id, hazards: hazards.length, audience: audience.kept.length, deliveries });
    // No user id is paired with the alert in the log (plan §23.D); counts only.
    logEvent('info', 'jobs.scenario.fired', { requestId: ctx.requestId, scenario: scenario.name, kind: scenario.kind, severity, hazards: hazards.length, audience: audience.kept.length, fatigued: audience.fatigued, quiet: audience.quiet, deliveries, alertId: alert.id });
  }
  outcome.note = outcome.fired.length ? outcome.fired.map((f) => `${f.kind}: ${f.hazards} hazards → ${f.audience} residents`).join('; ') : `nothing fired (${Object.values(outcome.skipped).join(', ') || 'no scenarios'})`;
  return outcome;
}

export const scenarioEval: JobFn = async (ctx) => {
  const outcome = await evaluateScenarios(ctx);
  const deadline = Object.values(outcome.skipped).includes('deadline');
  return { done: !deadline, cursor: deadline ? { resume: true } : null, processed: outcome.fired.length, note: outcome.note };
};

/**
 * The storm multiplier in force for a report with these sensitivities (spec §7: 1.0 unless a matching scenario is
 * active, then that scenario's multiplier, clamped). Reads the runs in status approved/dispatched from the last
 * RUN_ACTIVE_MS. The nightly recompute does not call this yet (plan §15: scenario multipliers are M2+ there).
 */
export async function activeStormMultiplier(kinds: readonly StormSensitivity[], opts: { repo?: AlertsRepo; now?: number } = {}): Promise<number> {
  if (kinds.length === 0) return 1;
  const now = opts.now ?? Date.now();
  const runs = await (opts.repo ?? getAlertsRepo()).activeRuns(isoAt(now - RUN_ACTIVE_MS));
  let best = 1;
  for (const r of runs) if (kinds.includes(r.kind)) best = Math.max(best, clampMultiplier(r.storm_multiplier));
  return best;
}
