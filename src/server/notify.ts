/**
 * Status-change notifications (plan §4 flow 6 "push to reporter + followers (quiet hours unless emergency)"; §11
 * channel policy row "Status change on own/followed report: push yes · SMS only if no device · inbox yes"; §23.H
 * "status-change notifications are not alert_delivery rows and never count" toward the fatigue budget).
 * notifyStatusChange() is exported for the M2 PATCH /api/v1/reports/:id route and is called nowhere else yet.
 *
 * Recipients are the reporter — never for an anonymous report, which has no reporter to address (plan §3.4, §23.D) —
 * plus every follower (voters auto-follow). Accounts inside their own quiet hours are skipped unless the report is an
 * emergency. Copy names the place and the new status in the resident's own words (RESIDENT_WORDING) and the payload
 * carries {reportId} so the tap deep-links to /report/[id]. The SMS leg for opted-in users without a device arrives
 * with channels.ts in M2 (§23.H schedule); such users are counted here so the gap is visible. Nothing here throws, and
 * no log line pairs a user id with the report id (§23.D). Server-only module.
 */
import { RESIDENT_WORDING } from '@/domain/status';
import { subtypeDef } from '@/domain/taxonomy';
import { inQuietHours } from '@/domain/time';
import type { ReportStatus } from '@/domain/types';
import type { ExpoPushTicket } from 'expo-server-sdk';

import { logEvent } from './log';
import { sendPush, type PushMessage } from './push';
import { getEngagementRepo, type EngagementRepo } from './repos/engagement';
import type { ReportRow } from './repos/types';

/** Android channel for status pushes (plan §9.4). */
export const STATUS_CHANNEL = 'rootcause-status';

export interface StatusNotifyResult {
  /** Distinct accounts addressed before quiet hours. */
  recipients: number;
  /** Skipped because the change arrived inside their quiet hours (non-emergency). */
  quiet: number;
  /** Would be addressed but have no registered device (SMS leg lands in M2). */
  noDevice: number;
  /** Pushes Expo accepted. */
  pushed: number;
  tickets: ExpoPushTicket[];
}

/** What follows "Open the report to see the timeline" for the statuses that ask something of the resident. */
const NEXT_STEP: Partial<Record<ReportStatus, string>> = {
  completed: ' and confirm the fix', // spec: status table — "Fixed — please verify"
  rejected: " and who owns it", // spec: status table — "Not city-owned — here's who owns it"
  scheduled: ' and the scheduled window', // spec: status table — "Scheduled — window given"
};

/** Title and body both name the place; the body names the action (plan §13 copy rule). */
export function statusChangeCopy(report: Pick<ReportRow, 'subtype' | 'address_text'>, from: ReportStatus, to: ReportStatus): { title: string; body: string } {
  const label = subtypeDef(report.subtype).label;
  const place = report.address_text.trim() || 'near you';
  return {
    title: `${place}: ${RESIDENT_WORDING[to]}`,
    body: `${label} at ${place} moved from “${RESIDENT_WORDING[from]}” to “${RESIDENT_WORDING[to]}”. Open the report to see the timeline${NEXT_STEP[to] ?? ''}.`,
  };
}

/** The reporter (unless anonymous) plus every follower, de-duplicated. */
export async function statusChangeRecipients(report: Pick<ReportRow, 'id' | 'reporter_id' | 'reporter_display'>, repo: EngagementRepo): Promise<string[]> {
  const ids = new Set<string>();
  if (report.reporter_id && report.reporter_display !== 'anonymous') ids.add(report.reporter_id);
  for (const id of await repo.followerIds(report.id)) ids.add(id);
  return [...ids];
}

export async function notifyStatusChange(report: ReportRow, from: ReportStatus, to: ReportStatus, opts: { now?: number } = {}): Promise<StatusNotifyResult> {
  const result: StatusNotifyResult = { recipients: 0, quiet: 0, noDevice: 0, pushed: 0, tickets: [] };
  try {
    const repo = getEngagementRepo();
    const now = opts.now ?? Date.now();
    const emergency = report.emergency_requested; // plan §11: quiet hours suppress everything except emergency
    const recipients = await statusChangeRecipients(report, repo);
    result.recipients = recipients.length;
    const awake: string[] = [];
    for (const userId of recipients) {
      const ctx = await repo.userContext(userId);
      if (!ctx) continue;
      if (!emergency && inQuietHours(now, ctx.quiet_hours)) {
        result.quiet += 1;
        continue;
      }
      awake.push(userId);
    }
    if (awake.length === 0) return result;

    const devices = await repo.devicesFor(awake);
    const withDevice = new Set(devices.map((d) => d.user_id));
    result.noDevice = awake.filter((id) => !withDevice.has(id)).length;
    if (devices.length === 0) return result;

    const copy = statusChangeCopy(report, from, to);
    const messages: PushMessage[] = devices.map((d) => ({
      to: d.expo_push_token,
      title: copy.title,
      body: copy.body,
      data: { kind: 'status', reportId: report.id, from, to },
      channelId: STATUS_CHANNEL,
      priority: emergency ? 'high' : 'default',
    }));
    const pushed = await sendPush(messages);
    result.pushed = pushed.sent;
    result.tickets = pushed.tickets;
    logEvent('info', 'notify.status_change', { reportId: report.id, from, to, recipients: result.recipients, quiet: result.quiet, noDevice: result.noDevice, pushed: result.pushed, invalidTokens: pushed.invalidTokens.length });
    return result;
  } catch (e) {
    logEvent('warn', 'notify.status_change_failed', { reportId: report.id, error: e instanceof Error ? e : new Error(String(e)) });
    return result;
  }
}
