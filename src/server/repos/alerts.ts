/**
 * Alerts repository contract (plan §6 weather_forecast / scenario / scenario_run / alert / alert_delivery; §7 /me/alerts
 * rows; §11 weatherPoll · scenarioEval · alertDispatch; §23.H fatigue budget and 20-per-tick dispatch; spec §9).
 * Rows are server-side snake_case shapes mirroring supabase/migrations/0001_init.sql; the only thing a route sends
 * back is MyAlert (src/domain/types.ts), whose body is the AlertBody the job wrote. A repo of its own with its own
 * factory because repos/types.ts is the frozen M0 contract (same reasoning as repos/me.ts and repos/engagement.ts).
 * getAlertsRepo() resolves the test override, then the dev-memory bundle (ROOTCAUSE_DEV_MEMORY=1, like
 * getPhotosRepo), then Supabase — and throws ConfigError when the env is missing so the route answers 503.
 * Server-only module.
 */
import type { StormSensitivity } from '@/domain/taxonomy';
import type { AlertBody, Category, Subtype } from '@/domain/types';

import { getServiceClient } from '../db';
import type { DeviceRow } from './engagement';
import { SupabaseAlertsRepo } from './supabase/alerts';
import { getRepos } from './types';

export type { DeviceRow };

/** weather_forecast (plan §11 weatherPoll): one row per poll; nulls are honest gaps in the source, never zeros. */
export interface ForecastRow {
  id: string;
  issued_at: string;
  valid_from: string;
  valid_to: string;
  /** NWS office + grid cell, e.g. "PHI/48,78". */
  grid_id: string;
  rain_mm: number | null;
  pop_pct: number | null;
  gust_kmh: number | null;
  temp_min: number | null;
  temp_max: number | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export type ForecastInsert = Omit<ForecastRow, 'id' | 'created_at'>;

/** scenario (spec §9 shape). trigger_expr is evaluated by src/domain/alerts.ts evaluateTrigger(). */
export interface ScenarioRow {
  id: string;
  name: string;
  kind: StormSensitivity;
  trigger_expr: unknown;
  action_thresholds: unknown;
  storm_multiplier: number;
  enabled: boolean;
  created_at: string;
}

export type ScenarioInsert = Omit<ScenarioRow, 'id' | 'created_at' | 'enabled'> & { enabled?: boolean };

export type RunStatus = 'proposed' | 'approved' | 'dispatched' | 'closed';

export interface ScenarioRunRow {
  id: string;
  scenario_id: string;
  forecast_id: string | null;
  triggered_at: string;
  /** Report ids, highest score first — the DPW pre-storm work list (spec 4.2 step 3). */
  worklist: string[];
  audience_count: number;
  status: RunStatus;
  outcome: unknown | null;
}

export type ScenarioRunInsert = Omit<ScenarioRunRow, 'id'>;

/** A run whose storm multiplier is active (status approved/dispatched, recently triggered). */
export interface ActiveRun {
  scenario_id: string;
  kind: StormSensitivity;
  storm_multiplier: number;
  triggered_at: string;
}

export type AlertSeverity = AlertBody['kind'];
export type AlertChannel = 'push' | 'sms' | 'email' | 'inbox';
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'undelivered';

export interface AlertRow {
  id: string;
  scenario_run_id: string | null;
  severity: AlertSeverity;
  channel_mix: Record<string, boolean>;
  audience_query: Record<string, unknown>;
  hazard_ids: string[];
  forecast_snapshot: unknown | null;
  body: AlertBody;
  scheduled_for: string | null;
  sent_at: string | null;
  created_at: string;
}

export type AlertInsert = Omit<AlertRow, 'id'>;

export interface DeliveryRow {
  alert_id: string;
  user_id: string;
  channel: AlertChannel;
  status: DeliveryStatus;
  /** Expo ticket id (push) / Twilio Message SID (sms). */
  provider_id: string | null;
  sent_at: string | null;
  opened_at: string | null;
  action_taken: string | null;
  error: string | null;
  created_at: string;
}

export type DeliveryInsert = Pick<DeliveryRow, 'alert_id' | 'user_id' | 'channel' | 'created_at'>;

/** A queued delivery with the alert it carries, for the dispatcher. */
export interface DueDelivery extends DeliveryRow {
  severity: AlertSeverity;
  body: AlertBody;
}

export interface DeliveryPatch {
  status: DeliveryStatus;
  provider_id: string | null;
  sent_at: string | null;
  error: string | null;
}

/** An open report as the scenario needs it — the briefing's facts, never the precise point. */
export interface HazardRow {
  id: string;
  subtype: Subtype;
  category: Category;
  address_text: string;
  created_at: string;
  score: number;
  storm_sensitivity: StormSensitivity[];
}

/** One alert for one account, deduplicated over channels (GET /api/v1/me/alerts). */
export interface MyAlertRow {
  alert_id: string;
  created_at: string;
  /** Any channel's delivery opened by this account. */
  opened_at: string | null;
  severity: AlertSeverity;
  body: unknown;
}

export interface AlertsRepo {
  // ---------- the inbox (GET /me/alerts, POST /me/alerts/:id/read) ----------
  /** The account's alerts, newest first, one row per alert whatever the channels. */
  listForUser(userId: string, limit: number): Promise<MyAlertRow[]>;
  /** Inbox copies are delivered the moment the phone fetches them (queued → delivered). */
  markInboxDelivered(userId: string, alertIds: readonly string[], now: string): Promise<void>;
  /** Sets opened_at on every delivery of the alert for this account; idempotent; false when the account has none. */
  markOpened(userId: string, alertId: string, now: string): Promise<boolean>;

  // ---------- weather (weatherPoll) ----------
  latestForecast(): Promise<ForecastRow | null>;
  saveForecast(row: ForecastInsert): Promise<ForecastRow>;

  // ---------- scenarios and runs (scenarioEval) ----------
  listScenarios(): Promise<ScenarioRow[]>;
  /** Inserts the code defaults when the table is empty (src/domain/alerts.ts DEFAULT_SCENARIOS). */
  seedScenarios(rows: readonly ScenarioInsert[]): Promise<ScenarioRow[]>;
  /** The newest run of the scenario triggered at or after `since`, else null (the 12 h cooldown). */
  recentRun(scenarioId: string, since: string): Promise<ScenarioRunRow | null>;
  /** Runs in status approved/dispatched triggered at or after `since`, with their scenario's kind and multiplier. */
  activeRuns(since: string): Promise<ActiveRun[]>;
  createRun(row: ScenarioRunInsert): Promise<ScenarioRunRow>;
  /** Open reports (memory/reports.ts OPEN_STATUSES) whose storm_sensitivity contains `kind`, highest score first. */
  openHazardsSensitiveTo(kind: StormSensitivity, limit: number): Promise<HazardRow[]>;
  createAlert(row: AlertInsert): Promise<AlertRow>;

  // ---------- audience (spec §9; audience_for_hazards RPC) ----------
  /** Accounts whose watch area touches a hazard's buffer and whose category list allows it. */
  audienceForHazards(hazardIds: readonly string[], bufferM: number): Promise<string[]>;
  /** Per account: COUNT(DISTINCT alert_id) of non-emergency alerts delivered by push or sms since `since` (plan §23.H). */
  fatigueUsed(userIds: readonly string[], since: string): Promise<Map<string, number>>;
  /** app_user.quiet_hours per account (repos/me.ts quietHoursOf shape). */
  quietHoursFor(userIds: readonly string[]): Promise<Map<string, { start: string; end: string } | null>>;
  devicesFor(userIds: readonly string[]): Promise<DeviceRow[]>;

  // ---------- deliveries (scenarioEval writes, alertDispatch sends) ----------
  /** Returns the number of rows written; a duplicate (alert, user, channel) is skipped, never an error. */
  insertDeliveries(rows: readonly DeliveryInsert[]): Promise<number>;
  /** Queued deliveries on one channel, oldest first, with the alert each carries. */
  dueDeliveries(channel: AlertChannel, limit: number): Promise<DueDelivery[]>;
  markDelivered(alertId: string, userId: string, channel: AlertChannel, patch: DeliveryPatch): Promise<void>;
}

let override: AlertsRepo | null = null;

/** The test override, the dev-memory bundle's repo, or the production repo over the service client (ConfigError → 503). */
export function getAlertsRepo(): AlertsRepo {
  if (override) return override;
  const bundle = getRepos() as Partial<{ alerts: AlertsRepo }>;
  if (bundle.alerts) return bundle.alerts;
  return new SupabaseAlertsRepo(getServiceClient());
}

/** Tests inject the memory repo; null restores the resolution above. */
export function setAlertsRepo(repo: AlertsRepo | null): void {
  override = repo;
}
