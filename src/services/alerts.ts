/**
 * Predictive alerts on the phone (spec R8/R9; plan §9.4, §11 channel policy "inbox yes", §23.H): refreshAlerts()
 * fetches the account's alerts (GET /api/v1/me/alerts) into the local inbox beside the status alerts mirrored from
 * pushes, and markAlertRead() posts the read receipt best-effort. Cache-first like everything else: never runs
 * offline, never while a demo scenario is active, never without a session, and a failure leaves the inbox as it was.
 * A server alert carries its briefing, so S-09 renders from local data afterwards. Nothing here throws.
 */
import { cacheMetaRepo } from '@/data/repos';
import { PILOT } from '@/domain/pilot';
import { toEpoch } from '@/domain/time';
import type { AlertItem, MyAlert } from '@/domain/types';
import { actions, getState, isOfflineNow } from '@/store/appStore';

import { alertsApi } from './apiClient';

/** Inbox ids of server alerts: "alert:<alert id>", so a push mirror (notification id) and the server copy never collide. */
export const SERVER_ALERT_PREFIX = 'alert:';

export const serverAlertItemId = (alertId: string): string => `${SERVER_ALERT_PREFIX}${alertId}`;

/** A MyAlert → the inbox item: the briefing travels with it, the kind is the alert's severity, no report deep link. */
export function toAlertItem(a: MyAlert): AlertItem {
  return { id: serverAlertItemId(a.id), kind: a.body.kind, title: a.body.title, body: a.body.body, reportId: null, alertId: a.id, at: a.at, read: a.read, briefing: a.body };
}

/**
 * The server's list replaces earlier server copies and the push mirrors of the same alerts (the server copy carries
 * the briefing; a read mark made on the phone is kept); status alerts and other local items stay. Newest first.
 */
export function mergeAlerts(local: readonly AlertItem[], server: readonly AlertItem[]): AlertItem[] {
  const serverIds = new Set(server.map((a) => a.alertId));
  const readLocally = new Set(local.filter((a) => a.read && a.alertId).map((a) => a.alertId));
  const kept = local.filter((a) => !a.id.startsWith(SERVER_ALERT_PREFIX) && !(a.alertId && serverIds.has(a.alertId)));
  const fresh = server.map((a) => (a.alertId && readLocally.has(a.alertId) ? { ...a, read: true } : a));
  return [...fresh, ...kept].sort((a, b) => toEpoch(b.at) - toEpoch(a.at));
}

export async function refreshAlerts(): Promise<'ok' | 'skipped' | 'failed'> {
  const s = getState();
  if (isOfflineNow(s) || s.settings.demoScenario || !s.session) return 'skipped';
  const res = await alertsApi.list();
  if (!res.ok) return 'failed';
  const server = res.data.alerts.map(toAlertItem);
  actions.setAlerts(mergeAlerts(getState().alerts, server));
  // Device time on purpose (same rule as services/refresh.ts): a download happened when it happened.
  actions.setCacheMeta(cacheMetaRepo.set({ key: 'alerts', fetchedAt: new Date().toISOString(), source: 'network', bytes: JSON.stringify(res.data.alerts).length, version: PILOT.slug }));
  return 'ok';
}

/** Marks the inbox item read on the phone first, then tells the server when it can (a lost receipt is not an error). */
export async function markAlertRead(id: string): Promise<void> {
  const s = getState();
  const item = s.alerts.find((a) => a.id === id);
  if (item && !item.read) actions.markAlertRead(id);
  if (!item?.alertId || item.isDemo || isOfflineNow(s) || s.settings.demoScenario || !s.session) return;
  await alertsApi.markRead(item.alertId);
}
