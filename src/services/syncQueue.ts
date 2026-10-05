/**
 * Offline-first sync queue (plan §9.2). Drafts and queued mutations are flushed on reconnect, on foreground,
 * after submit and after sign-in, sequentially, with the retry policy from the plan: retry on network/408/429/5xx
 * and on 401 after a token refresh; fail (and say why) on 400/403/422.
 *
 * M0: the queue exists and is wired into refresh; uploads land in M1 together with `/api/v1/photos` and
 * `POST /api/v1/reports`. Until then `flush()` leaves drafts as `queued` and reports zero sent.
 */
import { getState, isOfflineNow } from '@/store/appStore';

export interface FlushResult {
  sent: number;
  failed: number;
  skipped: number;
}

let inFlight: Promise<FlushResult> | null = null;

export function flush(): Promise<FlushResult> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (isOfflineNow()) return { sent: 0, failed: 0, skipped: getState().drafts.filter((d) => d.status === 'queued').length };
    // TODO(M1): upload photos → create report (clientDraftId) → mark sent; then queued mutations.
    return { sent: 0, failed: 0, skipped: getState().drafts.filter((d) => d.status === 'queued').length };
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
