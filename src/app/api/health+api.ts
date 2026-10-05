/**
 * GET /api/health — version, database reachability (the query doubles as the Free-plan keep-alive, plan §3.2), each
 * job's last successful run and quota usage against the Free-plan limits (plan §7, §22 monitoring). Public, no
 * secrets. When the server is misconfigured it still answers — 503 with the reason — so the uptime check says what
 * is wrong. Memory repos make it testable without a database (plan §14).
 */
import { ConfigError } from '@/server/env';
import { json, withTiming } from '@/server/http';
import { getRepos, type Repos } from '@/server/repos/types';

import pkg from '../../../package.json';

export const VERSION: string = pkg.version;

export const FREE_PLAN_QUOTA = {
  dbBytes: 500 * 1024 * 1024, // spec: plan §3.2 Free plan 500 MB database
  storageBytes: 1024 * 1024 * 1024, // spec: plan §3.2 Free plan 1 GB Storage
  upgradeAtPct: 70, // spec: plan §3.2 "an upgrade is triggered at 70 % of either quota"
} as const;

function pct(used: number | null, quota: number): number | null {
  return used === null ? null : Math.round((used / quota) * 1000) / 10;
}

const handleGet = withTiming('GET /api/health', async () => {
  const serverTime = new Date().toISOString();
  let repos: Repos;
  try {
    repos = getRepos();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return json({ ok: false, version: VERSION, serverTime, error: { code: 'misconfigured', message: 'The server is not configured.' } }, { status: 503 });
  }
  const [db, jobs, usage] = await Promise.all([repos.health.ping(), repos.jobs.lastOkByName(), repos.health.usage()]);
  const body = {
    ok: db.ok,
    version: VERSION,
    serverTime,
    db,
    jobs,
    usage: { ...usage, dbPct: pct(usage.dbBytes, FREE_PLAN_QUOTA.dbBytes), storagePct: pct(usage.storageBytes, FREE_PLAN_QUOTA.storageBytes), upgradeAtPct: FREE_PLAN_QUOTA.upgradeAtPct },
  };
  return json(body, { status: db.ok ? 200 : 503 });
});

export async function GET(request: Request): Promise<Response> {
  return handleGet(request);
}
