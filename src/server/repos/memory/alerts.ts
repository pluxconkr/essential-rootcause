/**
 * In-memory AlertsRepo for the route and job tests and the dev server (plan §14): forecasts, scenarios, runs, alerts
 * and deliveries live in this instance; hazards are read from the MemoryReportsRepo rows the routes write, so a test
 * files reports the way the app does and the scenario finds them. The audience is the SQL of audience_for_hazards()
 * done with geo.distanceM over seeded watch areas (point + radius, category list); quiet hours and devices are seeded
 * by tests because MemoryUsersRepo carries no such columns. Deterministic ids (wf_000001, sc_000001, run_000001,
 * al_000001). Server-only module.
 */
import { distanceM, type LatLng } from '@/domain/geo';
import type { Category, StormSensitivity } from '@/domain/types';

import type { ActiveRun, AlertChannel, AlertInsert, AlertRow, AlertsRepo, DeliveryInsert, DeliveryPatch, DeliveryRow, DeviceRow, DueDelivery, ForecastInsert, ForecastRow, HazardRow, MyAlertRow, ScenarioInsert, ScenarioRow, ScenarioRunInsert, ScenarioRunRow } from '../alerts';
import type { UsersRepo } from '../types';
import { OPEN_STATUSES, type MemoryReportsRepo } from './reports';

export interface MemoryWatchArea {
  user_id: string;
  lat: number;
  lng: number;
  radius_m: number;
  /** Empty = every category (plan §6 watch_area.categories). */
  categories: Category[];
}

const pad = (n: number) => String(n).padStart(6, '0');
const ACTIVE_RUN: readonly ScenarioRunRow['status'][] = ['approved', 'dispatched'];

export class MemoryAlertsRepo implements AlertsRepo {
  readonly forecasts: ForecastRow[] = [];
  readonly scenarios: ScenarioRow[] = [];
  readonly runs: ScenarioRunRow[] = [];
  readonly alerts: AlertRow[] = [];
  readonly deliveries: DeliveryRow[] = [];
  readonly watchAreas: MemoryWatchArea[] = [];
  readonly devices: DeviceRow[] = [];
  readonly quietHours = new Map<string, { start: string; end: string } | null>();
  private seq = 0;

  constructor(
    private readonly users: UsersRepo,
    private readonly reports: MemoryReportsRepo,
  ) {}

  // ---------- test seeds ----------

  seedWatchArea(area: MemoryWatchArea): void {
    this.watchAreas.push({ ...area, categories: [...area.categories] });
  }

  seedDevice(device: DeviceRow): void {
    this.devices.push({ ...device });
  }

  seedQuietHours(userId: string, window: { start: string; end: string } | null): void {
    this.quietHours.set(userId, window);
  }

  // ---------- inbox ----------

  async listForUser(userId: string, limit: number): Promise<MyAlertRow[]> {
    const byAlert = new Map<string, MyAlertRow>();
    for (const d of this.deliveries) {
      if (d.user_id !== userId) continue;
      const alert = this.alerts.find((a) => a.id === d.alert_id);
      if (!alert) continue;
      const prev = byAlert.get(d.alert_id);
      const opened = prev?.opened_at ?? d.opened_at;
      byAlert.set(d.alert_id, { alert_id: alert.id, created_at: alert.created_at, opened_at: opened ?? d.opened_at ?? null, severity: alert.severity, body: alert.body });
    }
    return [...byAlert.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.alert_id.localeCompare(a.alert_id)).slice(0, limit);
  }

  async markInboxDelivered(userId: string, alertIds: readonly string[], now: string): Promise<void> {
    const wanted = new Set(alertIds);
    for (const d of this.deliveries) {
      if (d.user_id === userId && d.channel === 'inbox' && d.status === 'queued' && wanted.has(d.alert_id)) {
        d.status = 'delivered';
        d.sent_at = now;
      }
    }
  }

  async markOpened(userId: string, alertId: string, now: string): Promise<boolean> {
    const mine = this.deliveries.filter((d) => d.user_id === userId && d.alert_id === alertId);
    if (mine.length === 0) return false;
    for (const d of mine) if (!d.opened_at) d.opened_at = now;
    return true;
  }

  // ---------- weather ----------

  async latestForecast(): Promise<ForecastRow | null> {
    const row = this.forecasts[this.forecasts.length - 1];
    return row ? { ...row, payload: { ...row.payload } } : null;
  }

  async saveForecast(input: ForecastInsert): Promise<ForecastRow> {
    const row: ForecastRow = { id: `wf_${pad(++this.seq)}`, created_at: new Date().toISOString(), ...input, payload: { ...input.payload } };
    this.forecasts.push(row);
    return { ...row };
  }

  // ---------- scenarios and runs ----------

  async listScenarios(): Promise<ScenarioRow[]> {
    return this.scenarios.map((s) => ({ ...s }));
  }

  async seedScenarios(rows: readonly ScenarioInsert[]): Promise<ScenarioRow[]> {
    const out: ScenarioRow[] = [];
    for (const r of rows) {
      const row: ScenarioRow = { id: `sc_${pad(++this.seq)}`, created_at: new Date().toISOString(), ...r, enabled: r.enabled ?? true };
      this.scenarios.push(row);
      out.push({ ...row });
    }
    return out;
  }

  async recentRun(scenarioId: string, since: string): Promise<ScenarioRunRow | null> {
    const row = this.runs
      .filter((r) => r.scenario_id === scenarioId && r.triggered_at >= since)
      .sort((a, b) => b.triggered_at.localeCompare(a.triggered_at))[0];
    return row ? { ...row, worklist: [...row.worklist] } : null;
  }

  async activeRuns(since: string): Promise<ActiveRun[]> {
    const out: ActiveRun[] = [];
    for (const r of this.runs) {
      if (!ACTIVE_RUN.includes(r.status) || r.triggered_at < since) continue;
      const s = this.scenarios.find((x) => x.id === r.scenario_id);
      if (s) out.push({ scenario_id: s.id, kind: s.kind, storm_multiplier: s.storm_multiplier, triggered_at: r.triggered_at });
    }
    return out;
  }

  async createRun(input: ScenarioRunInsert): Promise<ScenarioRunRow> {
    const row: ScenarioRunRow = { id: `run_${pad(++this.seq)}`, ...input, worklist: [...input.worklist] };
    this.runs.push(row);
    return { ...row, worklist: [...row.worklist] };
  }

  async openHazardsSensitiveTo(kind: StormSensitivity, limit: number): Promise<HazardRow[]> {
    return this.reports.rows
      .filter((r) => OPEN_STATUSES.includes(r.status) && r.storm_sensitivity.includes(kind))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((r) => ({ id: r.id, subtype: r.subtype, category: r.category, address_text: r.address_text, created_at: r.created_at, score: r.score, storm_sensitivity: [...r.storm_sensitivity] }));
  }

  async createAlert(input: AlertInsert): Promise<AlertRow> {
    const row: AlertRow = { id: `al_${pad(++this.seq)}`, ...input, hazard_ids: [...input.hazard_ids] };
    this.alerts.push(row);
    return { ...row, hazard_ids: [...row.hazard_ids] };
  }

  // ---------- audience ----------

  async audienceForHazards(hazardIds: readonly string[], bufferM: number): Promise<string[]> {
    const wanted = new Set(hazardIds);
    const hazards = this.reports.rows.filter((r) => wanted.has(r.id));
    const out = new Set<string>();
    for (const w of this.watchAreas) {
      if (out.has(w.user_id)) continue;
      const point: LatLng = { lat: w.lat, lng: w.lng };
      const hit = hazards.some((h) => distanceM(point, { lat: h.lat, lng: h.lng }) <= bufferM + w.radius_m && (w.categories.length === 0 || w.categories.includes(h.category)));
      if (hit && (await this.users.getById(w.user_id))) out.add(w.user_id);
    }
    return [...out];
  }

  async fatigueUsed(userIds: readonly string[], since: string): Promise<Map<string, number>> {
    const wanted = new Set(userIds);
    const perUser = new Map<string, Set<string>>();
    for (const d of this.deliveries) {
      if (!wanted.has(d.user_id) || (d.channel !== 'push' && d.channel !== 'sms') || d.created_at < since) continue;
      const alert = this.alerts.find((a) => a.id === d.alert_id);
      if (!alert || alert.severity === 'emergency') continue;
      const set = perUser.get(d.user_id) ?? new Set<string>();
      set.add(d.alert_id);
      perUser.set(d.user_id, set);
    }
    return new Map([...perUser].map(([id, set]) => [id, set.size] as const));
  }

  async quietHoursFor(userIds: readonly string[]): Promise<Map<string, { start: string; end: string } | null>> {
    return new Map(userIds.map((id) => [id, this.quietHours.get(id) ?? null] as const));
  }

  async devicesFor(userIds: readonly string[]): Promise<DeviceRow[]> {
    const wanted = new Set(userIds);
    return this.devices.filter((d) => wanted.has(d.user_id)).map((d) => ({ ...d }));
  }

  // ---------- deliveries ----------

  async insertDeliveries(rows: readonly DeliveryInsert[]): Promise<number> {
    let n = 0;
    for (const r of rows) {
      if (this.deliveries.some((d) => d.alert_id === r.alert_id && d.user_id === r.user_id && d.channel === r.channel)) continue;
      this.deliveries.push({ ...r, status: 'queued', provider_id: null, sent_at: null, opened_at: null, action_taken: null, error: null });
      n++;
    }
    return n;
  }

  async dueDeliveries(channel: AlertChannel, limit: number): Promise<DueDelivery[]> {
    const out: DueDelivery[] = [];
    for (const d of [...this.deliveries].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      if (d.channel !== channel || d.status !== 'queued') continue;
      const alert = this.alerts.find((a) => a.id === d.alert_id);
      if (!alert) continue;
      out.push({ ...d, severity: alert.severity, body: alert.body });
      if (out.length >= limit) break;
    }
    return out;
  }

  async markDelivered(alertId: string, userId: string, channel: AlertChannel, patch: DeliveryPatch): Promise<void> {
    const row = this.deliveries.find((d) => d.alert_id === alertId && d.user_id === userId && d.channel === channel);
    if (!row) return;
    row.status = patch.status;
    row.provider_id = patch.provider_id;
    row.sent_at = patch.sent_at;
    row.error = patch.error;
  }
}
