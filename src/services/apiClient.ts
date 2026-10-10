/**
 * The phone's only network client. Plain fetch + zod, 10 s timeout, bearer token when signed in, an install id
 * header for rate limiting. Never throws: every call returns an ApiResult. Relative `/api` works on web dev;
 * native builds set EXPO_PUBLIC_API_URL.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { z, type ZodType } from 'zod';

import { kv } from '@/data/kv';
import { newId } from '@/domain/ids';
import { MeExportSchema, MeProfileSchema, MyAlertListSchema, PhoneStartResponseSchema, PublicReportListSchema, PublicReportSchema, VerifyResponseSchema, type MePatch, type PublicReport, type VerifyInput, type VerifyResponse } from '@/domain/types';

import { getAccessToken } from './token';

/**
 * Where the API routes live. EXPO_PUBLIC_API_URL when set (EAS Hosting in production); otherwise, in a development
 * build the Expo dev server that serves this bundle also serves the `+api.ts` routes, so its host:port is the base
 * (Constants.expoConfig.hostUri, e.g. "192.168.1.20:8081"); on the web it is the page's own origin (relative URLs).
 */
function resolveApiUrl(): string {
  const fromEnv = (process.env.EXPO_PUBLIC_API_URL ?? '').trim().replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  if (Platform.OS === 'web') return '';
  const host = Constants.expoConfig?.hostUri?.trim();
  return host ? `http://${host.replace(/\/$/, '')}` : '';
}
export const API_URL = resolveApiUrl();
export const REQUEST_TIMEOUT_MS = 10_000;

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; code: string; message: string; retryAfterMs: number | null };

const INSTALL_KEY = 'install:v1';

/** Per-install id (not a secret, not an identity): an extra rate-limit dimension, never the only key. */
export function installId(): string {
  let id = kv.get<string>(INSTALL_KEY);
  if (!id) {
    id = newId('i');
    kv.set(INSTALL_KEY, id);
  }
  return id;
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const s = Number(h);
  return Number.isFinite(s) ? s * 1000 : null;
}

export async function api<T>(path: string, schema: ZodType<T>, init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const token = await getAccessToken();
    const headers: Record<string, string> = { Accept: 'application/json', 'x-install-id': installId(), ...(init.headers ?? {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
    const isBinary = init.body instanceof Uint8Array; // a multipart body framed by services/photos.ts (its Content-Type comes in init.headers)
    if (init.body !== undefined && !isForm && !isBinary) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API_URL}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : isForm ? (init.body as FormData) : isBinary ? (init.body as unknown as BodyInit) : JSON.stringify(init.body), signal: controller.signal });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      return { ok: false, status: res.status, code: err?.code ?? `http_${res.status}`, message: err?.message ?? res.statusText, retryAfterMs: retryAfterMs(res) };
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) return { ok: false, status: res.status, code: 'bad_shape', message: 'Unexpected response shape', retryAfterMs: null };
    return { ok: true, status: res.status, data: parsed.data };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return { ok: false, status: 0, code: aborted ? 'timeout' : 'network', message: aborted ? 'Request timed out' : 'No connection', retryAfterMs: null };
  } finally {
    clearTimeout(timer);
  }
}

export const reportsApi = {
  list(params: { bbox?: string; cat?: string; status?: string; sort?: string; cursor?: string; limit?: number }) {
    const q = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    return api(`/api/v1/reports${q ? `?${q}` : ''}`, PublicReportListSchema);
  },
  get(id: string): Promise<ApiResult<PublicReport>> {
    // GET /api/v1/reports/:id answers an envelope `{ report }`; unwrap it so callers get the PublicReport.
    return api(`/api/v1/reports/${encodeURIComponent(id)}`, z.object({ report: PublicReportSchema }).transform((b) => b.report));
  },
};

/** Report lifecycle (spec §4.4): the resident half. Staff moves (PATCH /api/v1/reports/:id) have no phone UI; the console and scripts/set-status.ts make them. */
export const lifecycleApi = {
  /** POST /api/v1/reports/:id/verify — the resident's verdict on a report marked fixed; 200 on a replay, 409 when the report is no longer `completed`. */
  verify(id: string, body: VerifyInput): Promise<ApiResult<VerifyResponse>> {
    return api(`/api/v1/reports/${encodeURIComponent(id)}/verify`, VerifyResponseSchema, { method: 'POST', body });
  },
};

/** Account routes (plan §7 /me rows). Every call needs a session — api() sends the bearer token when there is one. */
export const meApi = {
  /** GET /api/v1/me/export: the whole JSON file (bigger than a feed page, so a longer timeout); 429 twice a day and the message says so. */
  export() {
    return api('/api/v1/me/export', MeExportSchema, { timeoutMs: 30_000 });
  },
  /** POST /api/v1/me/phone: Twilio Verify sends the 6-digit code; only the last four digits come back. */
  startPhone(phone: string) {
    return api('/api/v1/me/phone', PhoneStartResponseSchema, { method: 'POST', body: { phone } });
  },
  /** POST /api/v1/me/phone/check: the code from the text → the updated profile (phoneVerified true). */
  checkPhone(code: string) {
    return api('/api/v1/me/phone/check', MeProfileSchema, { method: 'POST', body: { code } });
  },
  /** PATCH /api/v1/me: display name, quiet hours, SMS opt-in (refused until a phone is verified). */
  patch(patch: MePatch) {
    return api('/api/v1/me', MeProfileSchema, { method: 'PATCH', body: patch });
  },
};

/** Predictive alerts (spec R8/R9; plan §7 /me rows): the account's inbox and its read receipts. Both need a session. */
export const alertsApi = {
  /** GET /api/v1/me/alerts: the account's alerts, newest first, each with its briefing (MyAlertListSchema). */
  list() {
    return api('/api/v1/me/alerts', MyAlertListSchema);
  },
  /** POST /api/v1/me/alerts/:id/read: idempotent read receipt; 404 when the account has no delivery of that alert. */
  markRead(alertId: string) {
    return api(`/api/v1/me/alerts/${encodeURIComponent(alertId)}/read`, z.object({ alertId: z.string(), read: z.boolean() }), { method: 'POST' });
  },
};
