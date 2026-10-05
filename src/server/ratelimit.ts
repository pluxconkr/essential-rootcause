/**
 * Rate limiting (plan §3.10): workerd keeps no memory between requests, so production limits live in Postgres via the
 * `rate_limit_hit(key, limit, window)` RPC over `rate_limit_counter` (plan §6). Keys are built with keyFor(): the
 * scope stays readable, every subject (user id, IP, install id) is hashed so the counters table holds no identities
 * (plan §12 "keyed by hashed user id in hourly windows"). MemoryRateLimiter exists for tests and the dev server only.
 * The Supabase limiter fails closed: an RPC error refuses the request. Server-only module.
 */
import { fnv1a } from '@/domain/geo';

import { type ServiceClient, getServiceClient } from './db';
import { logEvent } from './log';

export interface RateLimiter {
  /** Records one hit for `key`; true when it is within `limit` per `windowSec`, false when the caller must get 429. */
  hit(key: string, limit: number, windowSec: number): Promise<boolean>;
}

/** One-way pseudonym for a subject (two salted FNV-1a passes → 16 hex chars). Not cryptographic; enough to keep ids out of the table. */
export function hashSubject(subject: string): string {
  return fnv1a(subject).toString(16).padStart(8, '0') + fnv1a(`rootcause:${subject}`).toString(16).padStart(8, '0');
}

/** `keyFor(['reports:create', userId])` → 'reports:create:<hash>'. The first part is the scope; every later part is hashed. */
export function keyFor(parts: readonly [scope: string, ...subjects: string[]]): string {
  const [scope, ...subjects] = parts;
  return [scope, ...subjects.map(hashSubject)].join(':');
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, limit: number, windowSec: number): Promise<boolean> {
    const t = this.now();
    const windowMs = windowSec * 1000;
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < windowMs);
    const allowed = recent.length < limit;
    if (allowed) recent.push(t);
    this.hits.set(key, recent);
    return allowed;
  }

  reset(): void {
    this.hits.clear();
  }
}

export class SupabaseRateLimiter implements RateLimiter {
  constructor(private readonly client: ServiceClient) {}

  async hit(key: string, limit: number, windowSec: number): Promise<boolean> {
    // contract: supabase/migrations/0001_init.sql defines rate_limit_hit(p_key text, p_limit int, p_window interval) → boolean,
    // true when this hit is BEYOND p_limit (hits 1..p_limit are allowed). PostgREST casts the JSON string to interval.
    const { data, error } = await this.client.rpc('rate_limit_hit', { p_key: key, p_limit: limit, p_window: `${windowSec} seconds` });
    if (error) {
      logEvent('warn', 'ratelimit.rpc_failed', { message: error.message });
      return false;
    }
    return data === false; // anything but an explicit "not over the limit" refuses (fail closed)
  }
}

let override: RateLimiter | null = null;

/** The DB-backed limiter, or the test override. Throws ConfigError when the env is missing — the route answers 503. */
export function getRateLimiter(): RateLimiter {
  return override ?? new SupabaseRateLimiter(getServiceClient());
}

/** Tests inject a MemoryRateLimiter; null restores the Supabase implementation. */
export function setRateLimiter(limiter: RateLimiter | null): void {
  override = limiter;
}
