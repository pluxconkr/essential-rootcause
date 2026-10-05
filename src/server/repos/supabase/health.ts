/**
 * Supabase HealthRepo and JobsRepo for /api/health (plan §7, §3.2): the ping is a real query so it doubles as the
 * Free-plan keep-alive; usage comes from the `usage_bytes()` RPC (db_bytes, storage_bytes) and is null when the RPC
 * is unavailable; jobs read job_run.last_ok_at per name. Nothing here throws — health must always answer.
 * Server-only module.
 */
import type { ServiceClient } from '../../db';
import { logEvent } from '../../log';
import type { HealthRepo, JobsRepo } from '../types';

function asBytes(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

export class SupabaseHealthRepo implements HealthRepo {
  constructor(private readonly client: ServiceClient) {}

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const started = Date.now();
    try {
      const { error } = await this.client.from('tenant').select('id', { count: 'exact', head: true });
      if (error) logEvent('warn', 'health.ping_failed', { message: error.message });
      return { ok: !error, latencyMs: Date.now() - started };
    } catch (e) {
      logEvent('warn', 'health.ping_failed', { error: e instanceof Error ? e : new Error(String(e)) });
      return { ok: false, latencyMs: Date.now() - started };
    }
  }

  async usage(): Promise<{ dbBytes: number | null; storageBytes: number | null }> {
    try {
      // contract: supabase/migrations defines usage_bytes() → one row {db_bytes bigint, storage_bytes bigint}.
      const { data, error } = await this.client.rpc('usage_bytes');
      if (error) {
        logEvent('warn', 'health.usage_failed', { message: error.message });
        return { dbBytes: null, storageBytes: null };
      }
      const row = (Array.isArray(data) ? data[0] : data) as { db_bytes?: unknown; storage_bytes?: unknown } | null;
      return { dbBytes: asBytes(row?.db_bytes), storageBytes: asBytes(row?.storage_bytes) };
    } catch {
      return { dbBytes: null, storageBytes: null };
    }
  }
}

export class SupabaseJobsRepo implements JobsRepo {
  constructor(private readonly client: ServiceClient) {}

  async lastOkByName(): Promise<Record<string, string | null>> {
    try {
      const { data, error } = await this.client.from('job_run').select('name, last_ok_at');
      if (error) {
        logEvent('warn', 'health.jobs_failed', { message: error.message });
        return {};
      }
      const out: Record<string, string | null> = {};
      for (const r of (data ?? []) as { name: string; last_ok_at: string | null }[]) {
        const prev = out[r.name];
        if (prev === undefined || (r.last_ok_at !== null && (prev === null || r.last_ok_at > prev))) out[r.name] = r.last_ok_at;
      }
      return out;
    } catch {
      return {};
    }
  }
}
