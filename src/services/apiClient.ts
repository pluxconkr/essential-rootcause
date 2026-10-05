/**
 * The phone's only network client. Plain fetch + zod, 10 s timeout, bearer token when signed in, an install id
 * header for rate limiting. Never throws: every call returns an ApiResult. Relative `/api` works on web dev;
 * native builds set EXPO_PUBLIC_API_URL.
 */
import type { ZodType } from 'zod';

import { kv } from '@/data/kv';
import { newId } from '@/domain/ids';
import { PublicReportListSchema, PublicReportSchema, type PublicReport } from '@/domain/types';

import { getAccessToken } from './auth';

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/$/, '');
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
    if (init.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API_URL}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : isForm ? (init.body as FormData) : JSON.stringify(init.body), signal: controller.signal });
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
    return api(`/api/v1/reports/${encodeURIComponent(id)}`, PublicReportSchema);
  },
};
