/**
 * Supabase SmsRepo over sms_message and alert_delivery (plan §6, §23.H, §12 webhook). Column contract with
 * supabase/migrations/0001_init.sql: sms_message (sid text pk, tenant_id, kind sms_kind, user_id, alert_id, to_last4,
 * status delivery_status default 'queued', error_code, created_at, updated_at; partial unique index
 * sms_message_claim_idx on (alert_id, user_id)) and alert_delivery (pk alert_id + user_id + channel, status,
 * provider_id, sent_at, error), plus tenant.sms_enabled. The claim insert detects a duplicate by the unique violation
 * (23505) so two ticks racing still send once; the webhook reads before it writes so an out-of-order callback never
 * moves a row backwards (advances()). Writes throw on a database error — the caller answers 500; the tenant switch
 * reads as false on a failed read, so nothing is sent. Server-only module.
 */
import type { ServiceClient } from '../../db';
import { logEvent } from '../../log';
import { advances, type DeliveryStatus, type SmsClaim, type SmsMessageRow, type SmsRepo } from '../sms';

const UNIQUE_VIOLATION = '23505';
const SMS_COLUMNS = 'sid, tenant_id, kind, user_id, alert_id, to_last4, status, error_code, created_at, updated_at';
const DELIVERY_COLUMNS = 'alert_id, user_id, channel, status';

interface DbDelivery {
  alert_id: string;
  user_id: string;
  channel: string;
  status: DeliveryStatus;
}

export class SupabaseSmsRepo implements SmsRepo {
  constructor(private readonly client: ServiceClient) {}

  async claim(c: SmsClaim): Promise<boolean> {
    const { error } = await this.client.from('sms_message').insert({ sid: c.sid, tenant_id: c.tenant_id, kind: c.kind, user_id: c.user_id, alert_id: c.alert_id, to_last4: c.to_last4, status: 'queued', created_at: c.now, updated_at: c.now });
    if (!error) return true;
    if (error.code === UNIQUE_VIOLATION) return false;
    throw new Error(`sms_message insert failed: ${error.message}`);
  }

  async confirm(claimSid: string, twilioSid: string, status: DeliveryStatus, now: string): Promise<void> {
    // The primary key changes from the claim id to the Message SID: nothing references sms_message, so this is one update.
    const { error } = await this.client.from('sms_message').update({ sid: twilioSid, status, updated_at: now }).eq('sid', claimSid);
    if (error) throw new Error(`sms_message update failed: ${error.message}`);
  }

  async fail(claimSid: string, errorCode: string | null, now: string): Promise<void> {
    const { error } = await this.client.from('sms_message').update({ status: 'failed', error_code: errorCode, updated_at: now }).eq('sid', claimSid);
    if (error) throw new Error(`sms_message update failed: ${error.message}`);
  }

  async updateStatus(sid: string, status: DeliveryStatus, errorCode: string | null, now: string): Promise<SmsMessageRow | null> {
    const { data, error } = await this.client.from('sms_message').select(SMS_COLUMNS).eq('sid', sid).maybeSingle();
    if (error) throw new Error(`sms_message read failed: ${error.message}`);
    if (!data) return null;
    const row = data as unknown as SmsMessageRow;
    if (!advances(row.status, status)) return row;
    const next = { status, error_code: errorCode ?? row.error_code, updated_at: now };
    const { error: writeError } = await this.client.from('sms_message').update(next).eq('sid', sid);
    if (writeError) throw new Error(`sms_message update failed: ${writeError.message}`);
    return { ...row, ...next };
  }

  async updateDeliveryByProviderId(providerId: string, status: DeliveryStatus, err: string | null, now: string): Promise<number> {
    const { data, error } = await this.client.from('alert_delivery').select(DELIVERY_COLUMNS).eq('provider_id', providerId);
    if (error) throw new Error(`alert_delivery read failed: ${error.message}`);
    let n = 0;
    for (const d of (data ?? []) as unknown as DbDelivery[]) {
      if (!advances(d.status, status)) continue;
      const patch: Record<string, unknown> = { status, error: err };
      if (status === 'sent') patch.sent_at = now;
      const { error: writeError } = await this.client.from('alert_delivery').update(patch).eq('alert_id', d.alert_id).eq('user_id', d.user_id).eq('channel', d.channel);
      if (writeError) throw new Error(`alert_delivery update failed: ${writeError.message}`);
      n++;
    }
    return n;
  }

  async tenantSmsEnabled(tenantId: string): Promise<boolean> {
    const { data, error } = await this.client.from('tenant').select('sms_enabled').eq('id', tenantId).maybeSingle();
    if (error) {
      logEvent('warn', 'sms.tenant_read_failed', { message: error.message });
      return false;
    }
    return (data as { sms_enabled?: unknown } | null)?.sms_enabled === true;
  }
}
