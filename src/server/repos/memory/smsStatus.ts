/**
 * In-memory SmsRepo for the sms/phone/webhook tests and the dev server (plan §14 "every +api.ts against
 * repos/memory/*"): the semantic oracle for repos/supabase/smsStatus.ts — the claim's partial unique index
 * (alert_id, user_id), the sid rewrite after Twilio answers, the webhook's rank rule and the tenant.sms_enabled
 * switch (`tenantEnabled`, true unless a test pauses it). alert_delivery rows are seeded by tests (no alerts repo is
 * involved). Server-only module.
 */
import { advances, type DeliveryStatus, type SmsClaim, type SmsMessageRow, type SmsRepo } from '../sms';

export interface MemoryAlertDelivery {
  alert_id: string;
  user_id: string;
  channel: 'push' | 'sms' | 'email' | 'inbox';
  status: DeliveryStatus;
  provider_id: string | null;
  sent_at: string | null;
  error: string | null;
}

export class MemorySmsRepo implements SmsRepo {
  readonly messages: SmsMessageRow[] = [];
  readonly deliveries: MemoryAlertDelivery[] = [];
  /** tenant.sms_enabled for every tenant: the runbook's pause, flipped by tests. */
  tenantEnabled = true;

  /** Tests: an alert_delivery row the webhook may update. */
  seedDelivery(row: Partial<MemoryAlertDelivery> & { alert_id: string; user_id: string; provider_id: string }): void {
    this.deliveries.push({ channel: 'sms', status: 'queued', sent_at: null, error: null, ...row });
  }

  async claim(c: SmsClaim): Promise<boolean> {
    if (c.alert_id !== null && c.user_id !== null && this.messages.some((m) => m.alert_id === c.alert_id && m.user_id === c.user_id)) return false;
    if (this.messages.some((m) => m.sid === c.sid)) return false;
    this.messages.push({ sid: c.sid, tenant_id: c.tenant_id, kind: c.kind, user_id: c.user_id, alert_id: c.alert_id, to_last4: c.to_last4, status: 'queued', error_code: null, created_at: c.now, updated_at: c.now });
    return true;
  }

  async confirm(claimSid: string, twilioSid: string, status: DeliveryStatus, now: string): Promise<void> {
    const row = this.messages.find((m) => m.sid === claimSid);
    if (!row) return;
    row.sid = twilioSid;
    row.status = status;
    row.updated_at = now;
  }

  async fail(claimSid: string, errorCode: string | null, now: string): Promise<void> {
    const row = this.messages.find((m) => m.sid === claimSid);
    if (!row) return;
    row.status = 'failed';
    row.error_code = errorCode;
    row.updated_at = now;
  }

  async updateStatus(sid: string, status: DeliveryStatus, errorCode: string | null, now: string): Promise<SmsMessageRow | null> {
    const row = this.messages.find((m) => m.sid === sid);
    if (!row) return null;
    if (advances(row.status, status)) {
      row.status = status;
      row.error_code = errorCode ?? row.error_code;
      row.updated_at = now;
    }
    return { ...row };
  }

  async updateDeliveryByProviderId(providerId: string, status: DeliveryStatus, error: string | null, now: string): Promise<number> {
    let n = 0;
    for (const d of this.deliveries) {
      if (d.provider_id !== providerId || !advances(d.status, status)) continue;
      d.status = status;
      d.error = error;
      if (status === 'sent') d.sent_at = now;
      n++;
    }
    return n;
  }

  async tenantSmsEnabled(): Promise<boolean> {
    return this.tenantEnabled;
  }
}
