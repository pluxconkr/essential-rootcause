/**
 * pushReceipts (plan §11, every 15 min): Expo push receipts say which tickets were delivered and which tokens are
 * dead (DeviceNotRegistered → drop the device row). v1 is a no-op because nothing persists ticket ids yet:
 * src/server/push.ts sendPush() returns the tickets to its caller, which deals with invalid tokens immediately, and
 * alert_delivery.provider_id (the ticket id per alert delivery) arrives with dispatch in M4.
 *
 * TODO(M4): read pending ticket ids from alert_delivery (channel = 'push', status = 'sent', provider_id set, sent_at
 * older than 15 min — Expo makes receipts available after about that long and keeps them 24 h), fetch them in chunks
 * with POST https://exp.host/--/api/v2/push/getReceipts via fetch (plain HTTP like push.ts; the Node-only expo-server-sdk is not used on workerd), mark rows delivered or
 * failed with the error, and delete device rows whose token appears in a DeviceNotRegistered receipt. The job then
 * becomes chunked like the others (cursor = last sent_at).
 */
import type { JobFn } from './types';

export const PUSH_RECEIPTS_INTERVAL_MS = 15 * 60_000; // spec: plan §11 pushReceipts "15 min"

export const pushReceipts: JobFn = async () => ({ done: true, cursor: null, processed: 0, note: 'no-op until ticket ids are stored (M4 alert_delivery.provider_id)' });
