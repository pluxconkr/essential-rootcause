/**
 * SMS repository contract (plan §6 sms_message / alert_delivery, §23.H "the row is the claim", §12 "Twilio webhook
 * … update alert_delivery"). Rows are server-side snake_case shapes of supabase/migrations/0001_init.sql: sms_message
 * (sid pk, tenant_id, kind sms_kind, user_id, alert_id, to_last4, status delivery_status, error_code) and the
 * alert_delivery row the webhook finds by provider_id, plus the tenant.sms_enabled switch sendSms checks before the
 * claim. Two implementations: repos/supabase/smsStatus.ts (service role) and repos/memory/smsStatus.ts (tests and
 * the dev-memory server, whose bundle getSmsRepo() reads like getMeRepo()). Otherwise getSmsRepo() fails closed
 * like getRepos(): a missing Supabase env throws ConfigError and the route answers 503 (plan §3.10). Server-only module.
 */
import { getServiceClient } from '../db';
import { getRepos } from './types';

/** sms_kind enum. 'otp' is unused since rev 4 (Twilio Verify sends the codes itself, plan §23.H) and kept for the enum. */
export type SmsKind = 'otp' | 'status' | 'page' | 'alert';

/** delivery_status enum, shared by sms_message and alert_delivery. */
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'undelivered';

export interface SmsMessageRow {
  /** The Twilio Message SID once Twilio answered; before that the claim id (`claim_<uuid>`). */
  sid: string;
  tenant_id: string;
  kind: SmsKind;
  user_id: string | null;
  alert_id: string | null;
  /** Last four digits only — the full number lives on app_user (plan §6). */
  to_last4: string;
  status: DeliveryStatus;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface SmsClaim {
  sid: string;
  tenant_id: string;
  kind: SmsKind;
  user_id: string | null;
  alert_id: string | null;
  to_last4: string;
  now: string;
}

/** Rank for the webhook's "ignore regressions" rule (plan §23.H): queued < sent < delivered; failed/undelivered are terminal. */
const RANK: Record<DeliveryStatus, number> = { queued: 0, sent: 1, delivered: 2, undelivered: 3, failed: 3 };

/** True when a callback moves the row forward; a repeated or out-of-order callback (sent after delivered) changes nothing. */
export function advances(from: DeliveryStatus, to: DeliveryStatus): boolean {
  if (from === 'failed' || from === 'undelivered') return false;
  return RANK[to] > RANK[from];
}

export interface SmsRepo {
  /** Inserts the claim row with status 'queued' BEFORE the Twilio call. false when the (alert_id, user_id) claim already exists — the caller must not send. */
  claim(claim: SmsClaim): Promise<boolean>;
  /** Twilio accepted the message: the claim id becomes the Message SID (the webhook's key) with the status Twilio reported. */
  confirm(claimSid: string, twilioSid: string, status: DeliveryStatus, now: string): Promise<void>;
  /** Twilio refused or the request failed: the claim row records it so a later tick and the escalation job can see it. */
  fail(claimSid: string, errorCode: string | null, now: string): Promise<void>;
  /** Webhook: the row by Message SID moved forward per advances(); the row as stored, or null when the SID is unknown. */
  updateStatus(sid: string, status: DeliveryStatus, errorCode: string | null, now: string): Promise<SmsMessageRow | null>;
  /** Webhook: alert_delivery rows whose provider_id is this SID (alerts only), same rule; the number of rows changed. */
  updateDeliveryByProviderId(providerId: string, status: DeliveryStatus, error: string | null, now: string): Promise<number>;
  /** tenant.sms_enabled (plan §23.I "SMS_ENABLED && tenant.sms_enabled"; runbook §6 pauses SMS by flipping it): false for an unknown tenant or a failed read. */
  tenantSmsEnabled(tenantId: string): Promise<boolean>;
}

let override: SmsRepo | null = null;

/** Production repo over the service client, the dev-memory bundle's, or the test override. Throws ConfigError when the env is missing — the route answers 503. */
export function getSmsRepo(): SmsRepo {
  if (override) return override;
  const bundle = getRepos() as Partial<{ sms: SmsRepo }>;
  if (bundle.sms) return bundle.sms; // the dev-memory server (ROOTCAUSE_DEV_MEMORY=1) carries its own
  // Lazy: supabase/smsStatus imports this module's helpers, so a static import would be a require cycle.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return new (require('./supabase/smsStatus') as typeof import('./supabase/smsStatus')).SupabaseSmsRepo(getServiceClient());
}

/** Tests inject the memory repo; null restores the lookup (dev-memory bundle, then Supabase). */
export function setSmsRepo(repo: SmsRepo | null): void {
  override = repo;
}
