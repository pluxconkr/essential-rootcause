/**
 * Supabase AlertsRepo over weather_forecast / scenario / scenario_run / alert / alert_delivery / device / app_user and
 * the RPC audience_for_hazards (plan §6, §11, §23.H; spec §9). One statement per call, no embedded joins; alert bodies
 * and severities are fetched in batch afterwards like repos/supabase/engagement.ts. Writes throw on a database error
 * so the job records the failure on job_run and retries the same chunk; the lookups an alert can live without
 * (devices) log and return empty.
 *
 * Column contract with supabase/migrations/0001_init.sql:
 *   - weather_forecast (issued_at, valid_from, valid_to, grid_id, rain_mm, pop_pct, gust_kmh, temp_min, temp_max, payload);
 *   - scenario (tenant_id, name, kind storm_sensitivity, trigger_expr, action_thresholds, storm_multiplier, enabled);
 *   - scenario_run (scenario_id, forecast_id, triggered_at, worklist jsonb, audience_count, status, outcome);
 *   - alert (tenant_id, scenario_run_id, severity alert_severity, channel_mix, audience_query, hazard_ids uuid[],
 *     forecast_snapshot, body = the AlertBody of src/domain/types.ts, scheduled_for, sent_at);
 *   - alert_delivery (alert_id, user_id, channel) PK, status delivery_status, provider_id, sent_at, opened_at, error;
 *   - audience_for_hazards(p_tenant, p_hazard_ids, p_buffer_m) → (user_id); tenant = the one tenant row (plan §6).
 * Server-only module.
 */
import type { StormSensitivity } from '@/domain/taxonomy';

import type { ServiceClient } from '../../db';
import { logEvent } from '../../log';
import type { ActiveRun, AlertChannel, AlertInsert, AlertRow, AlertsRepo, DeliveryInsert, DeliveryPatch, DeliveryRow, DeviceRow, DueDelivery, ForecastInsert, ForecastRow, HazardRow, MyAlertRow, ScenarioInsert, ScenarioRow, ScenarioRunInsert, ScenarioRunRow } from '../alerts';
import { quietHoursOf } from '../me';
import { OPEN_STATUSES } from '../memory/reports';

const UNIQUE_VIOLATION = '23505';
const FORECAST_COLUMNS = 'id, issued_at, valid_from, valid_to, grid_id, rain_mm, pop_pct, gust_kmh, temp_min, temp_max, payload, created_at';
const SCENARIO_COLUMNS = 'id, name, kind, trigger_expr, action_thresholds, storm_multiplier, enabled, created_at';
const RUN_COLUMNS = 'id, scenario_id, forecast_id, triggered_at, worklist, audience_count, status, outcome';
const ALERT_COLUMNS = 'id, scenario_run_id, severity, channel_mix, audience_query, hazard_ids, forecast_snapshot, body, scheduled_for, sent_at, created_at';
const DELIVERY_COLUMNS = 'alert_id, user_id, channel, status, provider_id, sent_at, opened_at, action_taken, error, created_at';
const HAZARD_COLUMNS = 'id, subtype, category, address_text, created_at, score, storm_sensitivity';

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function forecastFromDb(r: Record<string, unknown>): ForecastRow {
  return {
    id: String(r.id),
    issued_at: String(r.issued_at),
    valid_from: String(r.valid_from),
    valid_to: String(r.valid_to),
    grid_id: String(r.grid_id),
    rain_mm: num(r.rain_mm),
    pop_pct: num(r.pop_pct),
    gust_kmh: num(r.gust_kmh),
    temp_min: num(r.temp_min),
    temp_max: num(r.temp_max),
    payload: r.payload && typeof r.payload === 'object' ? (r.payload as Record<string, unknown>) : {},
    created_at: String(r.created_at),
  };
}

function scenarioFromDb(r: Record<string, unknown>): ScenarioRow {
  return { id: String(r.id), name: String(r.name), kind: r.kind as StormSensitivity, trigger_expr: r.trigger_expr ?? null, action_thresholds: r.action_thresholds ?? {}, storm_multiplier: num(r.storm_multiplier) ?? 1, enabled: r.enabled === true, created_at: String(r.created_at) };
}

function runFromDb(r: Record<string, unknown>): ScenarioRunRow {
  return { id: String(r.id), scenario_id: String(r.scenario_id), forecast_id: r.forecast_id ? String(r.forecast_id) : null, triggered_at: String(r.triggered_at), worklist: Array.isArray(r.worklist) ? r.worklist.map(String) : [], audience_count: Number(r.audience_count ?? 0), status: r.status as ScenarioRunRow['status'], outcome: r.outcome ?? null };
}

function alertFromDb(r: Record<string, unknown>): AlertRow {
  return {
    id: String(r.id),
    scenario_run_id: r.scenario_run_id ? String(r.scenario_run_id) : null,
    severity: r.severity as AlertRow['severity'],
    channel_mix: (r.channel_mix as Record<string, boolean> | null) ?? {},
    audience_query: (r.audience_query as Record<string, unknown> | null) ?? {},
    hazard_ids: Array.isArray(r.hazard_ids) ? r.hazard_ids.map(String) : [],
    forecast_snapshot: r.forecast_snapshot ?? null,
    body: r.body as AlertRow['body'],
    scheduled_for: r.scheduled_for ? String(r.scheduled_for) : null,
    sent_at: r.sent_at ? String(r.sent_at) : null,
    created_at: String(r.created_at),
  };
}

export class SupabaseAlertsRepo implements AlertsRepo {
  private tenantId: string | null = null;

  constructor(private readonly client: ServiceClient) {}

  // ---------- inbox ----------

  async listForUser(userId: string, limit: number): Promise<MyAlertRow[]> {
    // Deliveries newest first (a few channels per alert), deduplicated per alert, then the bodies in one batch.
    const { data, error } = await this.client.from('alert_delivery').select('alert_id, opened_at, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit * 4);
    if (error) throw new Error(`alert_delivery read failed: ${error.message}`);
    const opened = new Map<string, string | null>();
    for (const d of (data ?? []) as { alert_id: string; opened_at: string | null }[]) {
      if (!opened.has(d.alert_id)) opened.set(d.alert_id, d.opened_at);
      else if (d.opened_at && !opened.get(d.alert_id)) opened.set(d.alert_id, d.opened_at);
    }
    const ids = [...opened.keys()].slice(0, limit);
    if (ids.length === 0) return [];
    const alerts = await this.client.from('alert').select('id, severity, body, created_at').in('id', ids).order('created_at', { ascending: false });
    if (alerts.error) throw new Error(`alert read failed: ${alerts.error.message}`);
    return ((alerts.data ?? []) as { id: string; severity: AlertRow['severity']; body: unknown; created_at: string }[]).map((a) => ({ alert_id: a.id, created_at: a.created_at, opened_at: opened.get(a.id) ?? null, severity: a.severity, body: a.body }));
  }

  async markInboxDelivered(userId: string, alertIds: readonly string[], now: string): Promise<void> {
    if (alertIds.length === 0) return;
    const { error } = await this.client.from('alert_delivery').update({ status: 'delivered', sent_at: now }).eq('user_id', userId).eq('channel', 'inbox').eq('status', 'queued').in('alert_id', [...alertIds]);
    if (error) throw new Error(`alert_delivery update failed: ${error.message}`);
  }

  async markOpened(userId: string, alertId: string, now: string): Promise<boolean> {
    const { data, error } = await this.client.from('alert_delivery').update({ opened_at: now }).eq('alert_id', alertId).eq('user_id', userId).is('opened_at', null).select('alert_id');
    if (error) throw new Error(`alert_delivery update failed: ${error.message}`);
    if ((data ?? []).length > 0) return true;
    const existing = await this.client.from('alert_delivery').select('alert_id').eq('alert_id', alertId).eq('user_id', userId).limit(1);
    if (existing.error) throw new Error(`alert_delivery read failed: ${existing.error.message}`);
    return (existing.data ?? []).length > 0;
  }

  // ---------- weather ----------

  async latestForecast(): Promise<ForecastRow | null> {
    const { data, error } = await this.client.from('weather_forecast').select(FORECAST_COLUMNS).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(`weather_forecast read failed: ${error.message}`);
    return data ? forecastFromDb(data as Record<string, unknown>) : null;
  }

  async saveForecast(row: ForecastInsert): Promise<ForecastRow> {
    const { data, error } = await this.client.from('weather_forecast').insert(row).select(FORECAST_COLUMNS).single();
    if (error || !data) throw new Error(`weather_forecast insert failed: ${error?.message ?? 'no row'}`);
    return forecastFromDb(data as Record<string, unknown>);
  }

  // ---------- scenarios and runs ----------

  async listScenarios(): Promise<ScenarioRow[]> {
    const { data, error } = await this.client.from('scenario').select(SCENARIO_COLUMNS).order('created_at', { ascending: true });
    if (error) throw new Error(`scenario read failed: ${error.message}`);
    return ((data ?? []) as Record<string, unknown>[]).map(scenarioFromDb);
  }

  async seedScenarios(rows: readonly ScenarioInsert[]): Promise<ScenarioRow[]> {
    if (rows.length === 0) return [];
    const tenant = await this.tenant();
    const { data, error } = await this.client
      .from('scenario')
      .insert(rows.map((r) => ({ tenant_id: tenant, name: r.name, kind: r.kind, trigger_expr: r.trigger_expr, action_thresholds: r.action_thresholds, storm_multiplier: r.storm_multiplier, enabled: r.enabled ?? true })))
      .select(SCENARIO_COLUMNS);
    if (error) throw new Error(`scenario insert failed: ${error.message}`);
    return ((data ?? []) as Record<string, unknown>[]).map(scenarioFromDb);
  }

  async recentRun(scenarioId: string, since: string): Promise<ScenarioRunRow | null> {
    const { data, error } = await this.client.from('scenario_run').select(RUN_COLUMNS).eq('scenario_id', scenarioId).gte('triggered_at', since).order('triggered_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(`scenario_run read failed: ${error.message}`);
    return data ? runFromDb(data as Record<string, unknown>) : null;
  }

  async activeRuns(since: string): Promise<ActiveRun[]> {
    const runs = await this.client.from('scenario_run').select('scenario_id, triggered_at').in('status', ['approved', 'dispatched']).gte('triggered_at', since);
    if (runs.error) throw new Error(`scenario_run read failed: ${runs.error.message}`);
    const rows = (runs.data ?? []) as { scenario_id: string; triggered_at: string }[];
    if (rows.length === 0) return [];
    const scenarios = await this.client.from('scenario').select('id, kind, storm_multiplier').in('id', Array.from(new Set(rows.map((r) => r.scenario_id))));
    if (scenarios.error) throw new Error(`scenario read failed: ${scenarios.error.message}`);
    const byId = new Map(((scenarios.data ?? []) as { id: string; kind: StormSensitivity; storm_multiplier: unknown }[]).map((s) => [s.id, s] as const));
    return rows.flatMap((r) => {
      const s = byId.get(r.scenario_id);
      return s ? [{ scenario_id: s.id, kind: s.kind, storm_multiplier: num(s.storm_multiplier) ?? 1, triggered_at: r.triggered_at }] : [];
    });
  }

  async createRun(row: ScenarioRunInsert): Promise<ScenarioRunRow> {
    const { data, error } = await this.client.from('scenario_run').insert(row).select(RUN_COLUMNS).single();
    if (error || !data) throw new Error(`scenario_run insert failed: ${error?.message ?? 'no row'}`);
    return runFromDb(data as Record<string, unknown>);
  }

  async openHazardsSensitiveTo(kind: StormSensitivity, limit: number): Promise<HazardRow[]> {
    const { data, error } = await this.client.from('report').select(HAZARD_COLUMNS).in('status', [...OPEN_STATUSES]).contains('storm_sensitivity', [kind]).order('score', { ascending: false }).order('id', { ascending: true }).limit(limit);
    if (error) throw new Error(`report read failed: ${error.message}`);
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      subtype: r.subtype as HazardRow['subtype'],
      category: r.category as HazardRow['category'],
      address_text: typeof r.address_text === 'string' ? r.address_text : '',
      created_at: String(r.created_at),
      score: num(r.score) ?? 0,
      storm_sensitivity: Array.isArray(r.storm_sensitivity) ? (r.storm_sensitivity as StormSensitivity[]) : [],
    }));
  }

  async createAlert(row: AlertInsert): Promise<AlertRow> {
    const tenant = await this.tenant();
    const { data, error } = await this.client.from('alert').insert({ tenant_id: tenant, ...row }).select(ALERT_COLUMNS).single();
    if (error || !data) throw new Error(`alert insert failed: ${error?.message ?? 'no row'}`);
    return alertFromDb(data as Record<string, unknown>);
  }

  // ---------- audience ----------

  async audienceForHazards(hazardIds: readonly string[], bufferM: number): Promise<string[]> {
    if (hazardIds.length === 0) return [];
    // contract: supabase/migrations/0001_init.sql audience_for_hazards(p_tenant uuid, p_hazard_ids uuid[], p_buffer_m double precision) → (user_id)
    const { data, error } = await this.client.rpc('audience_for_hazards', { p_tenant: await this.tenant(), p_hazard_ids: [...hazardIds], p_buffer_m: bufferM });
    if (error) throw new Error(`audience_for_hazards failed: ${error.message}`);
    return Array.from(new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id)));
  }

  async fatigueUsed(userIds: readonly string[], since: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (userIds.length === 0) return out;
    const { data, error } = await this.client.from('alert_delivery').select('user_id, alert_id').in('user_id', [...userIds]).in('channel', ['push', 'sms']).gte('created_at', since);
    if (error) throw new Error(`alert_delivery read failed: ${error.message}`);
    const rows = (data ?? []) as { user_id: string; alert_id: string }[];
    if (rows.length === 0) return out;
    const alerts = await this.client.from('alert').select('id, severity').in('id', Array.from(new Set(rows.map((r) => r.alert_id))));
    if (alerts.error) throw new Error(`alert read failed: ${alerts.error.message}`);
    const counted = new Set(((alerts.data ?? []) as { id: string; severity: string }[]).filter((a) => a.severity !== 'emergency').map((a) => a.id));
    const perUser = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!counted.has(r.alert_id)) continue;
      const set = perUser.get(r.user_id) ?? new Set<string>();
      set.add(r.alert_id);
      perUser.set(r.user_id, set);
    }
    for (const [id, set] of perUser) out.set(id, set.size);
    return out;
  }

  async quietHoursFor(userIds: readonly string[]): Promise<Map<string, { start: string; end: string } | null>> {
    const out = new Map<string, { start: string; end: string } | null>();
    if (userIds.length === 0) return out;
    const { data, error } = await this.client.from('app_user').select('id, quiet_hours').in('id', [...userIds]);
    if (error) throw new Error(`app_user read failed: ${error.message}`);
    for (const u of (data ?? []) as { id: string; quiet_hours: unknown }[]) out.set(u.id, quietHoursOf(u.quiet_hours));
    return out;
  }

  async devicesFor(userIds: readonly string[]): Promise<DeviceRow[]> {
    const wanted = Array.from(new Set(userIds));
    if (wanted.length === 0) return [];
    const { data, error } = await this.client.from('device').select('user_id, expo_push_token, platform').in('user_id', wanted);
    if (error) {
      logEvent('warn', 'alerts.devices_failed', { message: error.message });
      return [];
    }
    return (data ?? []) as DeviceRow[];
  }

  // ---------- deliveries ----------

  async insertDeliveries(rows: readonly DeliveryInsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    const { data, error } = await this.client
      .from('alert_delivery')
      .upsert(
        rows.map((r) => ({ alert_id: r.alert_id, user_id: r.user_id, channel: r.channel, status: 'queued', created_at: r.created_at })),
        { onConflict: 'alert_id,user_id,channel', ignoreDuplicates: true },
      )
      .select('alert_id');
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return 0;
      throw new Error(`alert_delivery insert failed: ${error.message}`);
    }
    return (data ?? []).length;
  }

  async dueDeliveries(channel: AlertChannel, limit: number): Promise<DueDelivery[]> {
    const { data, error } = await this.client.from('alert_delivery').select(DELIVERY_COLUMNS).eq('channel', channel).eq('status', 'queued').order('created_at', { ascending: true }).limit(limit);
    if (error) throw new Error(`alert_delivery read failed: ${error.message}`);
    const rows = (data ?? []) as DeliveryRow[];
    if (rows.length === 0) return [];
    const alerts = await this.client.from('alert').select('id, severity, body').in('id', Array.from(new Set(rows.map((r) => r.alert_id))));
    if (alerts.error) throw new Error(`alert read failed: ${alerts.error.message}`);
    const byId = new Map(((alerts.data ?? []) as { id: string; severity: AlertRow['severity']; body: AlertRow['body'] }[]).map((a) => [a.id, a] as const));
    return rows.flatMap((r) => {
      const a = byId.get(r.alert_id);
      return a ? [{ ...r, severity: a.severity, body: a.body }] : [];
    });
  }

  async markDelivered(alertId: string, userId: string, channel: AlertChannel, patch: DeliveryPatch): Promise<void> {
    const { error } = await this.client.from('alert_delivery').update({ status: patch.status, provider_id: patch.provider_id, sent_at: patch.sent_at, error: patch.error }).eq('alert_id', alertId).eq('user_id', userId).eq('channel', channel);
    if (error) throw new Error(`alert_delivery update failed: ${error.message}`);
  }

  // ---------- helpers ----------

  /** The one tenant row (plan §6), the same way repos/jobs.ts reads its weights. */
  private async tenant(): Promise<string> {
    if (this.tenantId) return this.tenantId;
    const { data, error } = await this.client.from('tenant').select('id').order('created_at', { ascending: true }).limit(1).maybeSingle();
    if (error || !data) throw new Error(`tenant read failed: ${error?.message ?? 'no tenant row'}`);
    this.tenantId = String((data as { id: unknown }).id);
    return this.tenantId;
  }
}
