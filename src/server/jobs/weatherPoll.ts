/**
 * weatherPoll (plan §11, every 15 min; spec 4.2 "15-min poll: forecast (rain mm/h, gust km/h, freeze-thaw cycles)"):
 * reads the NWS gridpoint products for the pilot centre and stores one weather_forecast row for the next 24 h —
 * the facts the scenarios are evaluated against (src/domain/alerts.ts ForecastFacts). NWS has no key; the only
 * requirement is a User-Agent (env NWS_USER_AGENT). Endpoints: GET /points/{lat},{lng} → properties.forecastHourly
 * (periods: probabilityOfPrecipitation, windSpeed/windGust in mph, temperature in °F) and properties.forecastGridData
 * (quantitativePrecipitation: mm over ISO-8601 intervals — the hourly product carries no rain amount). Rain = the
 * largest 6-hour rolling sum of QPF inside the horizon (peakRainWindow also says where that block starts, which is
 * the window scenarioEval puts on the briefing); a product that is missing leaves its columns null rather
 * than 0, so a rule reading a null fact cannot fire. Never throws: any NWS failure is logged and the job ends with
 * a note — the app degrades to the last stored forecast (spec §10 "degrade gracefully"). Not chunked: one grid cell.
 */
import { PILOT } from '@/domain/pilot';

import { getServerEnv } from '../env';
import { logEvent } from '../log';
import { getAlertsRepo, type ForecastInsert, type ForecastRow } from '../repos/alerts';
import { isoAt, outOfTime, type JobContext, type JobFn } from './types';

export const WEATHER_POLL_INTERVAL_MS = 15 * 60_000; // spec: plan §11 weatherPoll "15 min"; spec 4.2 "15-min poll"
export const NWS_API = 'https://api.weather.gov'; // spec: plan §2 integrations "NWS gridpoint forecast"
export const NWS_TIMEOUT_MS = 6_000; // two round trips must fit the tick budget (plan §23.G: 20 s) with room for the write
export const FORECAST_HORIZON_H = 24; // the scenarios look at "tonight": 24 h is the horizon the body quotes
export const RAIN_WINDOW_H = 6; // spec: §9 trigger_expr "forecast.rain_mm_6h"
const HOUR_MS = 3_600_000;
const MPH_TO_KMH = 1.609344;
const INCH_TO_MM = 25.4;

/** The hourly product's period, the fields used here. */
export interface NwsPeriod {
  startTime: string;
  endTime?: string;
  temperature?: number | null;
  temperatureUnit?: string;
  probabilityOfPrecipitation?: { value: number | null } | null;
  windSpeed?: string | null;
  windGust?: string | null;
  shortForecast?: string;
}

/** A gridpoint layer value: an ISO-8601 interval ("2026-10-10T18:00:00+00:00/PT6H") and the amount over it. */
export interface NwsGridValue {
  validTime: string;
  value: number | null;
}

export interface NwsProducts {
  gridId: string;
  hourly: { updated: string | null; periods: NwsPeriod[] } | null;
  qpf: { uom: string; values: NwsGridValue[] } | null;
}

export interface ForecastSummary {
  rainMm6h: number | null;
  popPct: number | null;
  gustKmh: number | null;
  tempMinC: number | null;
  tempMaxC: number | null;
}

// ---------- parsing (exported for the tests) ----------

/** "20 mph", "15 to 25 mph", "32 km/h" → km/h (the largest figure); null for anything else. */
export function parseSpeedKmh(s: string | null | undefined): number | null {
  if (!s) return null;
  const numbers = s.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (numbers.length === 0) return null;
  const max = Math.max(...numbers);
  const kmh = /km\/?h/i.test(s) ? max : max * MPH_TO_KMH;
  return Math.round(kmh * 10) / 10;
}

/** ISO-8601 duration (PT6H, PT30M, P1D, P1DT6H) → ms; 0 for anything else. */
export function parseDurationMs(d: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d.trim());
  if (!m) return 0;
  const [, days, hours, minutes, seconds] = m;
  return (Number(days ?? 0) * 24 + Number(hours ?? 0)) * HOUR_MS + Number(minutes ?? 0) * 60_000 + Number(seconds ?? 0) * 1000;
}

const toC = (value: number | null | undefined, unit: string | undefined): number | null => (value === null || value === undefined || !Number.isFinite(value) ? null : unit === 'C' ? value : Math.round(((value - 32) * 5) / 9 * 10) / 10);

/**
 * Hourly rain buckets (mm) from `from` over `hours`; each QPF interval's amount is spread evenly over its hours. Bucket i
 * is the clock hour nearest to from + i h, so a poll minutes past the hour keeps the hour underway. null = no QPF at all.
 */
export function hourlyRainMm(values: readonly NwsGridValue[], uom: string, from: number, hours: number): (number | null)[] {
  const buckets: (number | null)[] = Array.from({ length: hours }, () => null);
  const factor = /in/i.test(uom) && !/mm/i.test(uom) ? INCH_TO_MM : 1;
  for (const v of values) {
    if (v.value === null || v.value === undefined || !Number.isFinite(v.value)) continue;
    const [startIso, duration] = v.validTime.split('/');
    const start = Date.parse(startIso ?? '');
    const ms = parseDurationMs(duration ?? '');
    if (!Number.isFinite(start) || ms <= 0) continue;
    const perHour = (v.value * factor) / (ms / HOUR_MS);
    for (let t = start; t < start + ms; t += HOUR_MS) {
      const i = Math.round((t - from) / HOUR_MS);
      if (i < 0 || i >= hours) continue;
      buckets[i] = (buckets[i] ?? 0) + perHour;
    }
  }
  return buckets;
}

/** The `window` consecutive buckets with the largest sum — the earliest such block: its start index and the sum (mm); null when every bucket is null. */
export function peakRainWindow(series: readonly (number | null)[], window: number): { start: number; mm: number } | null {
  if (series.every((v) => v === null)) return null;
  let best = { start: 0, mm: 0 };
  for (let i = 0; i + window <= Math.max(series.length, window); i++) {
    const sum = series.slice(i, i + window).reduce<number>((acc, v) => acc + (v ?? 0), 0);
    if (sum > best.mm) best = { start: i, mm: sum };
  }
  return { start: best.start, mm: Math.round(best.mm * 10) / 10 };
}

/** The largest sum over `window` consecutive buckets; null when every bucket is null. */
export function maxRollingSum(series: readonly (number | null)[], window: number): number | null {
  return peakRainWindow(series, window)?.mm ?? null;
}

/** Periods that start inside [from, from + hours). */
export function periodsInHorizon(periods: readonly NwsPeriod[], from: number, hours: number): NwsPeriod[] {
  const end = from + hours * HOUR_MS;
  return periods.filter((p) => {
    const t = Date.parse(p.startTime);
    return Number.isFinite(t) && t >= from - HOUR_MS && t < end;
  });
}

export function summarize(products: Pick<NwsProducts, 'hourly' | 'qpf'>, now: number, hours = FORECAST_HORIZON_H): ForecastSummary {
  const periods = products.hourly ? periodsInHorizon(products.hourly.periods, now, hours) : [];
  const pops = periods.map((p) => p.probabilityOfPrecipitation?.value).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const gusts = periods.map((p) => parseSpeedKmh(p.windGust) ?? parseSpeedKmh(p.windSpeed)).filter((v): v is number => v !== null);
  const temps = periods.map((p) => toC(p.temperature, p.temperatureUnit)).filter((v): v is number => v !== null);
  const rain = products.qpf ? maxRollingSum(hourlyRainMm(products.qpf.values, products.qpf.uom, now, hours), RAIN_WINDOW_H) : null;
  return {
    rainMm6h: rain,
    popPct: pops.length ? Math.max(...pops) : null,
    gustKmh: gusts.length ? Math.max(...gusts) : null,
    tempMinC: temps.length ? Math.min(...temps) : null,
    tempMaxC: temps.length ? Math.max(...temps) : null,
  };
}

// ---------- NWS ----------

type Fetch = typeof fetch;

async function getJson(url: string, userAgent: string, fetchFn: Fetch): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, { headers: { 'user-agent': userAgent, accept: 'application/geo+json' }, signal: AbortSignal.timeout(NWS_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`nws ${res.status} for ${new URL(url).pathname}`);
  return (await res.json()) as Record<string, unknown>;
}

/** points → (hourly, gridpoint) in parallel. A missing product is null, not a throw; both missing throws. */
export async function fetchNwsProducts(center: { lat: number; lng: number }, userAgent: string, fetchFn: Fetch = fetch): Promise<NwsProducts> {
  const points = await getJson(`${NWS_API}/points/${center.lat.toFixed(4)},${center.lng.toFixed(4)}`, userAgent, fetchFn);
  const props = (points.properties ?? {}) as Record<string, unknown>;
  const gridId = `${String(props.gridId ?? '?')}/${String(props.gridX ?? '?')},${String(props.gridY ?? '?')}`;
  const hourlyUrl = typeof props.forecastHourly === 'string' ? props.forecastHourly : null;
  const gridUrl = typeof props.forecastGridData === 'string' ? props.forecastGridData : null;
  const [hourly, grid] = await Promise.allSettled([hourlyUrl ? getJson(hourlyUrl, userAgent, fetchFn) : Promise.reject(new Error('no forecastHourly url')), gridUrl ? getJson(gridUrl, userAgent, fetchFn) : Promise.reject(new Error('no forecastGridData url'))]);
  if (hourly.status === 'rejected') logEvent('warn', 'jobs.weather.hourly_failed', { error: hourly.reason instanceof Error ? hourly.reason : new Error(String(hourly.reason)) });
  if (grid.status === 'rejected') logEvent('warn', 'jobs.weather.gridpoint_failed', { error: grid.reason instanceof Error ? grid.reason : new Error(String(grid.reason)) });
  if (hourly.status === 'rejected' && grid.status === 'rejected') throw new Error('nws: no forecast product answered');
  const hp = hourly.status === 'fulfilled' ? ((hourly.value.properties ?? {}) as Record<string, unknown>) : null;
  const gp = grid.status === 'fulfilled' ? ((grid.value.properties ?? {}) as Record<string, unknown>) : null;
  const qpf = gp && gp.quantitativePrecipitation && typeof gp.quantitativePrecipitation === 'object' ? (gp.quantitativePrecipitation as { uom?: string; values?: NwsGridValue[] }) : null;
  return {
    gridId,
    hourly: hp ? { updated: typeof hp.updateTime === 'string' ? hp.updateTime : typeof hp.generatedAt === 'string' ? hp.generatedAt : null, periods: Array.isArray(hp.periods) ? (hp.periods as NwsPeriod[]) : [] } : null,
    qpf: qpf && Array.isArray(qpf.values) ? { uom: qpf.uom ?? 'wmoUnit:mm', values: qpf.values } : null,
  };
}

/** The row to store: the summary, the window and a trimmed copy of what NWS said (never the whole product). */
export function toForecastRow(products: NwsProducts, now: number): ForecastInsert {
  const summary = summarize(products, now);
  const periods = products.hourly ? periodsInHorizon(products.hourly.periods, now, FORECAST_HORIZON_H) : [];
  return {
    issued_at: products.hourly?.updated ?? isoAt(now),
    valid_from: isoAt(now),
    valid_to: isoAt(now + FORECAST_HORIZON_H * HOUR_MS),
    grid_id: products.gridId,
    rain_mm: summary.rainMm6h,
    pop_pct: summary.popPct,
    gust_kmh: summary.gustKmh,
    temp_min: summary.tempMinC,
    temp_max: summary.tempMaxC,
    payload: {
      source: 'nws',
      products: { hourly: products.hourly !== null, qpf: products.qpf !== null },
      periods: periods.map((p) => ({ start: p.startTime, tempC: toC(p.temperature, p.temperatureUnit), popPct: p.probabilityOfPrecipitation?.value ?? null, gustKmh: parseSpeedKmh(p.windGust) ?? parseSpeedKmh(p.windSpeed), short: p.shortForecast ?? null })),
      rainMmByHour: products.qpf ? hourlyRainMm(products.qpf.values, products.qpf.uom, now, FORECAST_HORIZON_H) : null,
    },
  };
}

export interface PollOptions {
  fetchFn?: Fetch;
  center?: { lat: number; lng: number };
}

/** One poll: fetch, summarise, store. Returns the stored row, or null (with the reason) when NWS did not answer. */
export async function pollWeather(ctx: Pick<JobContext, 'now' | 'deadline' | 'requestId'>, opts: PollOptions = {}): Promise<{ row: ForecastRow | null; note: string }> {
  const userAgent = getServerEnv().nwsUserAgent;
  let products: NwsProducts;
  try {
    products = await fetchNwsProducts(opts.center ?? PILOT.center, userAgent, opts.fetchFn ?? fetch);
  } catch (e) {
    logEvent('warn', 'jobs.weather.unavailable', { requestId: ctx.requestId, error: e instanceof Error ? e : new Error(String(e)) });
    return { row: null, note: `nws unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (outOfTime(ctx)) return { row: null, note: 'out of time before the write' };
  const row = await getAlertsRepo().saveForecast(toForecastRow(products, ctx.now));
  logEvent('info', 'jobs.weather.stored', { requestId: ctx.requestId, gridId: row.grid_id, rainMm: row.rain_mm, popPct: row.pop_pct, gustKmh: row.gust_kmh, tempMin: row.temp_min, tempMax: row.temp_max, hourly: products.hourly !== null, qpf: products.qpf !== null });
  return { row, note: `${row.grid_id}: rain ${row.rain_mm ?? '—'} mm/6h, pop ${row.pop_pct ?? '—'} %, gust ${row.gust_kmh ?? '—'} km/h` };
}

export const weatherPoll: JobFn = async (ctx) => {
  const { row, note } = await pollWeather(ctx);
  return { done: true, cursor: null, processed: row ? 1 : 0, note };
};
