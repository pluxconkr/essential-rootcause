/**
 * GET /api/health against the memory repos (plan §7, §14): version from package.json, db ping, jobs' last OK, usage
 * against the Free-plan quota; 503 — not a crash — when the Supabase env is missing or the ping fails; never a
 * secret-looking name in the body.
 */
import { FREE_PLAN_QUOTA, GET } from '@/app/api/health+api';
import { resetServiceClient } from '@/server/db';
import { setLogSink } from '@/server/log';
import { createMemoryRepos } from '@/server/repos/memory';
import { setRepos } from '@/server/repos/types';

import pkg from '../../package.json';

const get = () => GET(new Request('http://localhost/api/health'));

beforeAll(() => setLogSink(() => {}));
afterAll(() => setLogSink(null));
afterEach(() => setRepos(null));

test('reports version, db ping, jobs and usage with the memory repos', async () => {
  setRepos(createMemoryRepos({ health: { ok: true, latencyMs: 12, dbBytes: 100 * 1024 * 1024, storageBytes: null }, jobs: { 'weather-poll': '2026-10-05T10:00:00.000Z', recompute: null } }));
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.headers.get('x-request-id')).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.version).toBe(pkg.version);
  expect(body.db).toEqual({ ok: true, latencyMs: 12 });
  expect(body.jobs).toEqual({ 'weather-poll': '2026-10-05T10:00:00.000Z', recompute: null });
  expect(body.usage).toEqual({ dbBytes: 100 * 1024 * 1024, storageBytes: null, dbPct: 20, storagePct: null, upgradeAtPct: FREE_PLAN_QUOTA.upgradeAtPct });
  expect(JSON.stringify(body)).not.toMatch(/SUPABASE|SERVICE_ROLE|SECRET|TOKEN|API_KEY/);
});

test('a failing database ping is 503 but still says what it knows', async () => {
  setRepos(createMemoryRepos({ health: { ok: false, latencyMs: 3000, dbBytes: null, storageBytes: null } }));
  const res = await get();
  expect(res.status).toBe(503);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.db.ok).toBe(false);
  expect(body.version).toBe(pkg.version);
});

test('answers 503 with the reason, not a crash, when the Supabase env is missing', async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  resetServiceClient();
  const res = await get();
  expect(res.status).toBe(503);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.error.code).toBe('misconfigured');
  expect(body.version).toBe(pkg.version);
  expect(JSON.stringify(body)).not.toMatch(/SUPABASE/);
});
