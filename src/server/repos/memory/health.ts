/**
 * In-memory HealthRepo and JobsRepo for the /api/health route test (plan §7): fixed answers a test can set.
 * Server-only module.
 */
import type { HealthRepo, JobsRepo } from '../types';

export interface MemoryHealthState {
  ok: boolean;
  latencyMs: number;
  dbBytes: number | null;
  storageBytes: number | null;
}

export class MemoryHealthRepo implements HealthRepo {
  constructor(public state: MemoryHealthState = { ok: true, latencyMs: 1, dbBytes: null, storageBytes: null }) {}

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    return { ok: this.state.ok, latencyMs: this.state.latencyMs };
  }

  async usage(): Promise<{ dbBytes: number | null; storageBytes: number | null }> {
    return { dbBytes: this.state.dbBytes, storageBytes: this.state.storageBytes };
  }
}

export class MemoryJobsRepo implements JobsRepo {
  constructor(public lastOk: Record<string, string | null> = {}) {}

  async lastOkByName(): Promise<Record<string, string | null>> {
    return { ...this.lastOk };
  }
}
