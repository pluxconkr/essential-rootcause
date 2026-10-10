/**
 * POST /api/dev/session (src/server/devSession.ts): a 404 unless the dev-memory server opts in; with the opt-in and a fake
 * Auth API it upserts the throwaway account (create or password reset), signs it in with the password grant and returns
 * the tokens; any address outside e2e.rootcause.app is refused, so a laptop on a shared network cannot mint sessions
 * for real people. No network in tests.
 */
import { POST } from '@/app/api/dev/session+api';
import { DEV_SESSION_DEFAULT_EMAIL, devSessionEnabled, isDevSessionEmail, mintDevSession } from '@/server/devSession';
import { setLogSink } from '@/server/log';

const url = 'http://localhost/api/dev/session';
const post = (body: unknown) => POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const saved: Record<string, string | undefined> = {};
const KEYS = ['ROOTCAUSE_DEV_MEMORY', 'ROOTCAUSE_DEV_SESSION', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NODE_ENV'];

beforeAll(() => {
  setLogSink(() => {});
  for (const k of KEYS) saved[k] = process.env[k];
});
afterAll(() => {
  setLogSink(null);
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  process.env.NODE_ENV = 'test';
});

function enable() {
  process.env.ROOTCAUSE_DEV_MEMORY = '1';
  process.env.ROOTCAUSE_DEV_SESSION = '1';
  process.env.SUPABASE_URL = 'https://proj.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
}

type Call = { url: string; method: string; body: Record<string, unknown> | null };
function fakeAuth(existing: { id: string; email: string }[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url: u, method, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/auth/v1/admin/users?')) return json({ users: existing });
    if (u.includes('/auth/v1/admin/users')) return json({ id: 'u_new' });
    if (u.includes('/auth/v1/token?grant_type=password')) return json({ access_token: 'at_dev', refresh_token: 'rt_dev' });
    return json({ msg: 'unexpected' }, 500);
  }) as typeof fetch;
  return { fetch: f, calls };
}

test('the route is a 404 unless the dev-memory server opts in, and never in production', async () => {
  expect(devSessionEnabled()).toBe(false);
  expect((await post({})).status).toBe(404);
  enable();
  expect(devSessionEnabled()).toBe(true);
  process.env.NODE_ENV = 'production';
  expect(devSessionEnabled()).toBe(false);
  expect((await post({})).status).toBe(404);
});

test('only throwaway addresses under the dev domain are accepted', () => {
  expect(isDevSessionEmail(DEV_SESSION_DEFAULT_EMAIL)).toBe(true);
  expect(isDevSessionEmail('Someone@E2E.rootcause.app ')).toBe(true);
  expect(isDevSessionEmail('jane@example.org')).toBe(false);
  expect(isDevSessionEmail('jane@rootcause.app')).toBe(false);
  expect(isDevSessionEmail('')).toBe(false);
});

test('a new throwaway account is created, an existing one gets a fresh password, and the password grant tokens come back', async () => {
  enable();
  const fresh = fakeAuth([]);
  const created = await mintDevSession(DEV_SESSION_DEFAULT_EMAIL, 'Sim Tester', fresh.fetch);
  expect(created).toEqual({ ok: true, accessToken: 'at_dev', refreshToken: 'rt_dev', email: DEV_SESSION_DEFAULT_EMAIL });
  expect(fresh.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST']);
  expect(fresh.calls[1].body).toMatchObject({ email: DEV_SESSION_DEFAULT_EMAIL, email_confirm: true, user_metadata: { full_name: 'Sim Tester' } });
  expect(String(fresh.calls[1].body?.password)).toMatch(/^Dev-[0-9a-f]{48}$/);
  expect(fresh.calls[2].body).toMatchObject({ email: DEV_SESSION_DEFAULT_EMAIL, password: fresh.calls[1].body?.password });

  const again = fakeAuth([{ id: 'u_sim', email: DEV_SESSION_DEFAULT_EMAIL }]);
  const reset = await mintDevSession(DEV_SESSION_DEFAULT_EMAIL, 'Sim Tester', again.fetch);
  expect(reset.ok).toBe(true);
  expect(again.calls[1]).toMatchObject({ method: 'PUT', url: 'https://proj.supabase.co/auth/v1/admin/users/u_sim' });

  const refused = await mintDevSession('jane@example.org', 'Jane', fresh.fetch);
  expect(refused).toMatchObject({ ok: false, status: 400 });
});

test('the route validates the body and maps failures to 400 / 503', async () => {
  enable();
  expect((await post({ email: 'jane@example.org' })).status).toBe(400);
  expect((await post({ email: 42 })).status).toBe(400);
  delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const res = await post({});
  expect(res.status).toBe(503);
  expect((await res.json()).error.code).toBe('misconfigured');
});
