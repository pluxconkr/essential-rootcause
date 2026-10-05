/**
 * Request/response helpers shared by every +api.ts route (plan §7: JSON everywhere, errors as {error: {code, message}},
 * 400 invalid · 401 no session · 403 capability · 404 · 429 limit with Retry-After · 503 misconfigured).
 * `withTiming` is the one wrapper every handler goes through: it assigns a request id, logs route/status/duration,
 * turns a thrown ConfigError into 503 (fail closed, §3.10) and anything else into 500 — so routes never leak a stack
 * trace and never hang. Server-only module.
 */
import type { z } from 'zod';

import { ConfigError } from './env';
import { logEvent } from './log';

export type ErrorCode = 'bad_request' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'invalid_transition' | 'rate_limited' | 'not_implemented' | 'misconfigured' | 'internal';

export function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, init);
}

export function error(status: number, code: ErrorCode, message: string, init: ResponseInit = {}): Response {
  return json({ error: { code, message } }, { ...init, status });
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/** "field: message; other.field: message" for the first three issues — enough to debug, never the submitted values. */
export function zodMessage(err: z.ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join('.') || 'body'}: ${i.message}`)
    .join('; ');
}

/** Body → schema; a non-JSON body or a schema failure is a 400 that names the first offending fields. */
export async function parseJson<S extends z.ZodType>(request: Request, schema: S): Promise<Parsed<z.output<S>>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: error(400, 'bad_request', 'Body must be JSON.') };
  }
  const result = schema.safeParse(raw);
  if (!result.success) return { ok: false, response: error(400, 'bad_request', `Invalid request. ${zodMessage(result.error)}`) };
  return { ok: true, data: result.data };
}

/** Caller-supplied x-request-id when it is a plain token, else a fresh UUID. */
export function requestId(request: Request): string {
  const given = request.headers.get('x-request-id')?.trim() ?? '';
  return /^[A-Za-z0-9_.-]{1,64}$/.test(given) ? given : crypto.randomUUID();
}

export function readBearer(request: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  return m ? m[1] : null;
}

/** First hop of x-forwarded-for, else the platform header, else 'unknown' (never throws). */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
}

export interface RouteContext {
  requestId: string;
  /** Dynamic segment values, e.g. {id} for reports/[id]+api.ts. */
  params: Record<string, string>;
}

export type RouteHandler = (request: Request, ctx: RouteContext) => Promise<Response>;

export function withTiming(route: string, handler: RouteHandler): (request: Request, params?: Record<string, string>) => Promise<Response> {
  return async (request, params = {}) => {
    const id = requestId(request);
    const started = Date.now();
    let response: Response;
    try {
      response = await handler(request, { requestId: id, params });
    } catch (e) {
      if (e instanceof ConfigError) {
        logEvent('error', 'route.misconfigured', { requestId: id, route, missing: e.missing });
        response = error(503, 'misconfigured', 'The server is not configured. Try again later.');
      } else {
        logEvent('error', 'route.error', { requestId: id, route, error: e instanceof Error ? e : new Error(String(e)) });
        response = error(500, 'internal', 'Something went wrong. Try again later.');
      }
    }
    try {
      response.headers.set('x-request-id', id);
    } catch {
      /* immutable headers (Response.error()) — the id is still in the log line */
    }
    logEvent('info', 'request', { requestId: id, route, method: request.method, status: response.status, durationMs: Date.now() - started });
    return response;
  };
}
