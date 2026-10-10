/**
 * alertDispatch (plan §11 "send scheduled alerts per channel policy"; §23.H "20 per tick … push batches go first";
 * §9.4 channel rootcause-alerts): every tick sends up to DISPATCH_PER_TICK queued push deliveries. Each alert_delivery
 * row becomes one Expo message per registered device of that account — title and body are the alert's (they already
 * name the place and the action), data carries {kind, alertId} so the tap opens /alert/[id] — and the row is marked
 * sent with the first accepted ticket id (provider_id, for pushReceipts) or failed with the reason. An account that
 * lost its devices since the alert was written is marked failed with "no device" rather than retried forever. SMS
 * rows arrive with channels.ts; inbox rows are delivered when GET /api/v1/me/alerts fetches them. Never throws past
 * the repo: sendPush() turns a transport failure into error tickets.
 */
import { logEvent } from '../log';
import { sendPush, type PushMessage } from '../push';
import { getAlertsRepo, type AlertsRepo } from '../repos/alerts';
import { isoAt, type JobContext, type JobFn } from './types';

export const DISPATCH_PER_TICK = 20; // spec: plan §23.H "20 per tick"
/**
 * Due on (nearly) every tick: pg_cron calls the tick each minute (plan §11 alertDispatch "1 min"), and dueState()
 * measures from the previous run's end, so a full minute would make the job run every other tick. Half a minute
 * absorbs the job's own run time; a second call inside the same minute (the GitHub Actions fallback) is skipped.
 */
export const ALERT_DISPATCH_INTERVAL_MS = 30_000;
export const ALERTS_CHANNEL = 'rootcause-alerts'; // spec: plan §9.4 Android channel for predictive alerts (high importance)

export interface DispatchOutcome {
  sent: number;
  failed: number;
  noDevice: number;
}

export async function dispatchQueuedPushes(ctx: Pick<JobContext, 'now' | 'requestId'>, opts: { repo?: AlertsRepo; limit?: number } = {}): Promise<DispatchOutcome> {
  const repo = opts.repo ?? getAlertsRepo();
  const outcome: DispatchOutcome = { sent: 0, failed: 0, noDevice: 0 };
  const due = await repo.dueDeliveries('push', opts.limit ?? DISPATCH_PER_TICK);
  if (due.length === 0) return outcome;
  const devices = await repo.devicesFor(due.map((d) => d.user_id));
  const nowIso = isoAt(ctx.now);
  const messages: PushMessage[] = [];
  const owner: number[] = []; // messages[i] belongs to due[owner[i]]
  due.forEach((d, i) => {
    for (const device of devices) {
      if (device.user_id !== d.user_id) continue;
      messages.push({ to: device.expo_push_token, title: d.body.title, body: d.body.body, data: { kind: d.body.kind, alertId: d.alert_id }, channelId: ALERTS_CHANNEL, priority: d.severity === 'emergency' ? 'high' : 'default' });
      owner.push(i);
    }
  });
  const result = messages.length > 0 ? await sendPush(messages) : { tickets: [], sent: 0, invalidTokens: [] };
  for (let i = 0; i < due.length; i++) {
    const d = due[i];
    const tickets = result.tickets.filter((_, j) => owner[j] === i);
    if (tickets.length === 0) {
      outcome.noDevice += 1;
      await repo.markDelivered(d.alert_id, d.user_id, 'push', { status: 'failed', provider_id: null, sent_at: null, error: 'no device' });
      continue;
    }
    const ok = tickets.find((t) => t.status === 'ok');
    if (ok && ok.status === 'ok') {
      outcome.sent += 1;
      await repo.markDelivered(d.alert_id, d.user_id, 'push', { status: 'sent', provider_id: ok.id, sent_at: nowIso, error: null });
    } else {
      outcome.failed += 1;
      const first = tickets[0];
      await repo.markDelivered(d.alert_id, d.user_id, 'push', { status: 'failed', provider_id: null, sent_at: null, error: first.status === 'error' ? `${first.details?.error ?? 'error'}: ${first.message}`.slice(0, 200) : 'error' });
    }
  }
  logEvent('info', 'jobs.alerts.dispatched', { requestId: ctx.requestId, due: due.length, messages: messages.length, sent: outcome.sent, failed: outcome.failed, noDevice: outcome.noDevice, invalidTokens: result.invalidTokens.length });
  return outcome;
}

export const alertDispatch: JobFn = async (ctx) => {
  const outcome = await dispatchQueuedPushes(ctx);
  const processed = outcome.sent + outcome.failed + outcome.noDevice;
  return { done: true, cursor: null, processed, note: processed === 0 ? 'nothing queued' : `sent ${outcome.sent}, failed ${outcome.failed}, no device ${outcome.noDevice}` };
};
