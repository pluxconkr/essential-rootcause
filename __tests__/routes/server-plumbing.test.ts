/**
 * Server plumbing with no route of its own, pinned against supabase/migrations/0001_init.sql so a TypeScript change
 * cannot drift from the SQL it calls: env defaults when optional variables are unset or blank (plan Appendix C);
 * the DB-backed limiter calls rate_limit_hit(p_key, p_limit, p_window_sec int) and reads its "true = within the
 * limit" answer, refusing on any error (plan §3.10 fail closed); find_duplicates receives the tenant id first; the
 * users repo resolves the tenant row by slug 'pilot' (plan §6, seed.sql).
 */
import { ENV_DEFAULTS, getServerEnv } from '@/server/env';
import { setLogSink } from '@/server/log';
import { SupabaseRateLimiter } from '@/server/ratelimit';
import { SupabaseReportsRepo } from '@/server/repos/supabase/reports';
import { SupabaseUsersRepo, TENANT_SLUG } from '@/server/repos/supabase/users';

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'VISION_DAILY_MAX', 'VISION_MODEL', 'VISION_ENABLED', 'SMS_ENABLED', 'OPEN311_API_KEYS'];

beforeAll(() => {
  setLogSink(() => {});
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterAll(() => {
  setLogSink(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('getServerEnv defaults', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://test-project.supabase.co/';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-for-tests';
    for (const k of ['VISION_DAILY_MAX', 'VISION_MODEL', 'VISION_ENABLED', 'SMS_ENABLED', 'OPEN311_API_KEYS']) delete process.env[k];
  });

  test('unset or blank optional variables take the documented defaults', () => {
    expect(getServerEnv()).toMatchObject({ supabaseUrl: 'https://test-project.supabase.co', visionDailyMax: ENV_DEFAULTS.visionDailyMax, visionModel: ENV_DEFAULTS.visionModel, visionEnabled: true, smsEnabled: false, open311ApiKeys: [] });
    process.env.VISION_DAILY_MAX = '  ';
    expect(getServerEnv().visionDailyMax).toBe(ENV_DEFAULTS.visionDailyMax);
  });

  test('an explicit value wins, including zero (the breaker off) and a bad number falls back', () => {
    process.env.VISION_DAILY_MAX = '0';
    expect(getServerEnv().visionDailyMax).toBe(0);
    process.env.VISION_DAILY_MAX = '250.9';
    expect(getServerEnv().visionDailyMax).toBe(250);
    process.env.VISION_DAILY_MAX = 'lots';
    expect(getServerEnv().visionDailyMax).toBe(ENV_DEFAULTS.visionDailyMax);
    process.env.OPEN311_API_KEYS = ' a, b ,,c ';
    expect(getServerEnv().open311ApiKeys).toEqual(['a', 'b', 'c']);
  });
});

describe('SupabaseRateLimiter against rate_limit_hit()', () => {
  const stub = (answer: { data?: unknown; error?: { message: string } | null }) => {
    const rpc = jest.fn(async () => ({ data: answer.data ?? null, error: answer.error ?? null }));
    return { rpc, limiter: new SupabaseRateLimiter({ rpc } as unknown as ConstructorParameters<typeof SupabaseRateLimiter>[0]) };
  };

  test('calls the migration signature with p_window_sec and allows only an explicit "within the limit" (true)', async () => {
    const allowed = stub({ data: true });
    expect(await allowed.limiter.hit('reports:create:abc', 10, 3600)).toBe(true);
    expect(allowed.rpc).toHaveBeenCalledWith('rate_limit_hit', { p_key: 'reports:create:abc', p_limit: 10, p_window_sec: 3600 });
    expect(await stub({ data: false }).limiter.hit('k', 10, 3600)).toBe(false);
  });

  test('fails closed on an RPC error or an unexpected answer', async () => {
    expect(await stub({ error: { message: 'function does not exist' } }).limiter.hit('k', 10, 3600)).toBe(false);
    expect(await stub({ data: null }).limiter.hit('k', 10, 3600)).toBe(false);
  });
});

describe('SupabaseReportsRepo.findDuplicates against find_duplicates()', () => {
  test('passes the tenant id first and normalises distance_m', async () => {
    const rpc = jest.fn(async () => ({ data: [{ id: 'r1', subtype: 'pothole', status: 'new', score: 40, vote_count: 2, address_text: null, created_at: 'x', distance_m: '12.5' }], error: null }));
    const users = { pilotTenantId: async () => 't-pilot' } as unknown as SupabaseUsersRepo;
    const repo = new SupabaseReportsRepo({ rpc } as unknown as ConstructorParameters<typeof SupabaseReportsRepo>[0], users);
    expect(await repo.findDuplicates(40.5, -74.4, 'pothole_cluster')).toEqual([{ id: 'r1', subtype: 'pothole', status: 'new', distance_m: 12.5 }]);
    expect(rpc).toHaveBeenCalledWith('find_duplicates', { p_tenant: 't-pilot', p_lat: 40.5, p_lng: -74.4, p_category: 'roadway', p_radius_m: 60 });
  });
});

describe('SupabaseUsersRepo tenant lookup', () => {
  test("resolves the tenant row by slug 'pilot' once and caches it", async () => {
    const eq = jest.fn();
    const chain = { select: () => ({ eq: (col: string, val: string) => { eq(col, val); return { maybeSingle: async () => ({ data: { id: 't-pilot' }, error: null }) }; } }) };
    const from = jest.fn(() => chain);
    const repo = new SupabaseUsersRepo({ from } as unknown as ConstructorParameters<typeof SupabaseUsersRepo>[0]);
    expect(TENANT_SLUG).toBe('pilot');
    expect(await repo.pilotTenantId()).toBe('t-pilot');
    expect(await repo.pilotTenantId()).toBe('t-pilot');
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('tenant');
    expect(eq).toHaveBeenCalledWith('slug', 'pilot');
  });
});
