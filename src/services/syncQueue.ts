/**
 * Offline-first sync queue for drafts (plan §9.2, §4 flows 2–3). flush() runs on reconnect, on foreground, after
 * submit and after sign-in — sequentially, oldest first. Per draft: upload the photo that has no server id yet
 * (POST /api/v1/photos) → create the report with the draft id as clientDraftId (POST /api/v1/reports; a replay
 * returns the original) → mark `sent`, link it in "My reports", cache the public report. Retry policy: a network
 * error, 408, 429 (Retry-After honoured) or 5xx keeps the draft `queued`; a 401 is retried once after the token
 * provider had a chance to refresh and otherwise parks the draft as `needs_sign_in` (shown in S-10/S-12); 400, 403,
 * 422 and every other 4xx is `failed` with the server's reason — never dropped silently. Nothing here throws.
 * Queued mutations (votes, comments, follows) belong to the engagement area and are not flushed here.
 */
import { z } from 'zod';

import { CreateReportInputSchema, PublicReportSchema, type CreateReportInput, type Draft, type PublicReport } from '@/domain/types';
import { actions, getState, isOfflineNow } from '@/store/appStore';

import { api, type ApiResult } from './apiClient';
import { getAccessToken, isSignedIn } from './auth';
import { uploadPhoto } from './photos';

export interface FlushResult {
  sent: number;
  failed: number;
  skipped: number;
}

export type SubmitOutcome = { outcome: 'sent'; report: PublicReport } | { outcome: 'queued'; reason: string } | { outcome: 'needs_sign_in' } | { outcome: 'failed'; reason: string };

/** `{report}` plus the queue position a later server may add (plan §9.1 S-07 "rank … when the server returns it"); S-07 computes it locally until then. */
export const CreateReportResponseSchema = z.object({ report: PublicReportSchema, rank: z.number().int().optional(), openInCategory: z.number().int().optional() });

export const RETRY = {
  /** A retryable answer without Retry-After waits at least this long; flush() runs on reconnect/foreground anyway. */
  backoffMs: 60_000,
} as const;

type Failure = Extract<ApiResult<unknown>, { ok: false }>;
export type FailureClass = 'retry' | 'sign_in' | 'fail';

/** plan §9.2: retry on network error, 408, 429 and 5xx; 401 asks for a session; everything else fails with its reason. */
export function classify(f: Failure): FailureClass {
  if (f.status === 0 || f.status === 408 || f.status === 429 || f.status >= 500) return 'retry';
  if (f.status === 401) return 'sign_in';
  return 'fail';
}

/** The CreateReportInput a draft submits (the draft id is the idempotency key), or what is still missing. */
export function draftToInput(draft: Draft): { ok: true; input: CreateReportInput } | { ok: false; reason: string } {
  const f = draft.form;
  const parsed = CreateReportInputSchema.safeParse({
    clientDraftId: draft.id,
    category: f.category,
    subtype: f.subtype,
    severityResident: f.severityResident,
    injuryFlag: f.injuryFlag,
    reporterDisplay: f.reporterDisplay,
    lat: f.lat ?? draft.gps?.lat,
    lng: f.lng ?? draft.gps?.lng,
    accuracyM: f.accuracyM ?? draft.gps?.accuracyM ?? null,
    locationConfirmed: f.locationConfirmed ?? draft.locationConfirmed,
    addressText: f.addressText?.trim() || undefined,
    note: f.note?.trim() || undefined,
    photoIds: draft.photoIds ?? [],
    capturedAt: draft.capturedAt,
  });
  if (!parsed.success) return { ok: false, reason: `This draft is missing: ${parsed.error.issues.slice(0, 3).map((i) => i.path.map(String).join('.') || 'details').join(', ')}.` };
  return { ok: true, input: parsed.data };
}

/** Draft id → epoch ms before which a 429/5xx draft is not retried. Process memory only: a restart simply tries again. */
const notBefore = new Map<string, number>();

/** When the queue will next try this draft, or null when nothing holds it back. */
export function nextAttemptAt(draftId: string): number | null {
  return notBefore.get(draftId) ?? null;
}

function latest(id: string, fallback: Draft): Draft {
  return getState().drafts.find((d) => d.id === id) ?? fallback;
}

/** One retry after a 401 once the token provider has refreshed (plan §9.2); no token means signed out. */
async function withRefresh<T>(call: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  const first = await call();
  if (first.ok || first.status !== 401) return first;
  const token = await getAccessToken();
  if (!token) return first;
  return call();
}

function park(draft: Draft, f: Failure): SubmitOutcome {
  const klass = classify(f);
  if (klass === 'retry') {
    notBefore.set(draft.id, Date.now() + (f.retryAfterMs ?? RETRY.backoffMs));
    actions.setDraftStatus(draft.id, 'queued');
    return { outcome: 'queued', reason: f.message };
  }
  if (klass === 'sign_in') {
    actions.setDraftStatus(draft.id, 'needs_sign_in');
    return { outcome: 'needs_sign_in' };
  }
  notBefore.delete(draft.id);
  actions.setDraftStatus(draft.id, 'failed', { failReason: f.message });
  return { outcome: 'failed', reason: f.message };
}

function markSent(draft: Draft, report: PublicReport): void {
  const anonymous = draft.form.reporterDisplay === 'anonymous';
  notBefore.delete(draft.id);
  actions.setDraftStatus(draft.id, 'sent', { reportId: report.id });
  actions.addMyReport({ reportId: report.id, draftId: draft.id, anonymous, createdAt: report.createdAt });
  actions.upsertReport(report);
  if (!anonymous) {
    // The server recorded the reporter's own vote and follow (plan §4 flow 2); anonymous reports have neither (plan §3.4).
    actions.setVoted(report.id, true);
    actions.setFollowed(report.id, true);
  }
}

/** Upload the photo if needed, then create the report. Used by the form (online submit) and by flush(). */
export async function submitDraft(input: Draft): Promise<SubmitOutcome> {
  let draft = latest(input.id, input);
  actions.setDraftStatus(draft.id, 'uploading');
  if (draft.photoUris.length > 0 && (draft.photoIds ?? []).length === 0) {
    const current = draft;
    const up = await withRefresh(() => uploadPhoto(current));
    if (!up.ok) return park(draft, up);
    actions.upsertDraft({ ...latest(draft.id, draft), photoIds: [up.data.photoId], updatedAt: new Date().toISOString() });
    draft = latest(draft.id, draft);
  }
  const built = draftToInput(draft);
  if (!built.ok) {
    actions.setDraftStatus(draft.id, 'failed', { failReason: built.reason });
    return { outcome: 'failed', reason: built.reason };
  }
  const res = await withRefresh(() => api('/api/v1/reports', CreateReportResponseSchema, { method: 'POST', body: built.input }));
  if (!res.ok) return park(draft, res);
  markSent(draft, res.data.report);
  return { outcome: 'sent', report: res.data.report };
}

let inFlight: Promise<FlushResult> | null = null;

/** Flush every due draft, one at a time. Concurrent calls share one run. */
export function flush(): Promise<FlushResult> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const result: FlushResult = { sent: 0, failed: 0, skipped: 0 };
    const signedIn = isSignedIn();
    // `uploading` is a draft a killed process left behind; `needs_sign_in` drafts become due once there is a session.
    const due = getState()
      .drafts.filter((d) => d.status === 'queued' || d.status === 'uploading' || (d.status === 'needs_sign_in' && signedIn))
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    if (isOfflineNow()) return { ...result, skipped: due.length };
    for (const draft of due) {
      const wait = notBefore.get(draft.id);
      if (wait !== undefined && Date.now() < wait) {
        result.skipped += 1;
        continue;
      }
      const out = await submitDraft(draft);
      if (out.outcome === 'sent') result.sent += 1;
      else if (out.outcome === 'failed') result.failed += 1;
      else result.skipped += 1;
    }
    return result;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
