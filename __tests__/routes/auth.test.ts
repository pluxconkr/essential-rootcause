/**
 * verifyJwt() and requireUser() (plan §12 "Supabase JWT verified (JWKS cached)"): keys are generated here, fetch is
 * mocked to serve the project JWKS, and the module cache is exercised — a hit needs no fetch, an unknown kid refreshes
 * once. Tokens that are tampered, expired, from another issuer or audience, HS256 or unsigned are refused.
 */
import { CLOCK_SKEW_SEC, jwksUrl, requireUser, resetJwksCache, setTestUser, verifyJwt } from '@/server/auth';
import { resetServiceClient } from '@/server/db';
import { setLogSink } from '@/server/log';
import { createMemoryRepos } from '@/server/repos/memory';

const SUPABASE_URL = 'https://test-project.supabase.co';

const b64url = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

interface Signer {
  jwk: JsonWebKey & { kid: string };
  alg: 'ES256' | 'RS256';
  sign(data: Uint8Array): Promise<ArrayBuffer>;
}

async function es256(kid: string): Promise<Signer> {
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', k.publicKey)), kid, alg: 'ES256', use: 'sig' };
  return { jwk, alg: 'ES256', sign: (data) => crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.privateKey, data as BufferSource) };
}

async function rs256(kid: string): Promise<Signer> {
  const k = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', k.publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { jwk, alg: 'RS256', sign: (data) => crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, k.privateKey, data as BufferSource) };
}

const nowSec = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({ iss: `${SUPABASE_URL}/auth/v1`, sub: 'u_jane', aud: 'authenticated', exp: nowSec() + 3600, iat: nowSec(), role: 'authenticated', email: 'jane@example.org', app_metadata: { provider: 'apple' }, user_metadata: { full_name: 'Jane Doe' }, ...over });

async function token(s: Signer, body: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const h = enc({ alg: s.alg, typ: 'JWT', kid: s.jwk.kid, ...header });
  const p = enc(body);
  return `${h}.${p}.${b64url(await s.sign(new TextEncoder().encode(`${h}.${p}`)))}`;
}

let es: Signer;
let rs: Signer;
let served: JsonWebKey[];
let fetchSpy: jest.SpyInstance;

beforeAll(async () => {
  setLogSink(() => {});
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-for-tests';
  es = await es256('es-1');
  rs = await rs256('rs-1');
});

afterAll(() => {
  setLogSink(null);
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  resetServiceClient();
  setTestUser(undefined);
});

beforeEach(() => {
  resetJwksCache();
  served = [es.jwk, rs.jwk];
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    expect(String(input)).toBe(jwksUrl(SUPABASE_URL));
    return new Response(JSON.stringify({ keys: served }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => fetchSpy.mockRestore());

test('verifies ES256 and RS256 tokens and caches the JWKS', async () => {
  const a = await verifyJwt(await token(es, claims()));
  expect(a?.userId).toBe('u_jane');
  expect(a?.claims.user_metadata?.full_name).toBe('Jane Doe');
  const b = await verifyJwt(await token(rs, claims({ sub: 'u_rsa' })));
  expect(b?.userId).toBe('u_rsa');
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test('an unknown kid refreshes the JWKS once; a key that is still unknown is refused', async () => {
  await verifyJwt(await token(es, claims()));
  const rotated = await es256('es-2');
  served = [rotated.jwk];
  expect((await verifyJwt(await token(rotated, claims())))?.userId).toBe('u_jane');
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  const stranger = await es256('es-3');
  expect(await verifyJwt(await token(stranger, claims()))).toBeNull();
  expect(fetchSpy).toHaveBeenCalledTimes(3);
});

test('refuses tampered, expired, future, wrong-issuer, wrong-audience, HS256 and unsigned tokens', async () => {
  const good = await token(es, claims());
  const [h, , s] = good.split('.');
  expect(await verifyJwt(`${h}.${enc(claims({ sub: 'u_mallory' }))}.${s}`)).toBeNull();
  expect(await verifyJwt(await token(es, claims({ exp: nowSec() - CLOCK_SKEW_SEC - 1 })))).toBeNull();
  expect((await verifyJwt(await token(es, claims({ exp: nowSec() - CLOCK_SKEW_SEC + 5 }))))?.userId).toBe('u_jane');
  expect(await verifyJwt(await token(es, claims({ iat: nowSec() + CLOCK_SKEW_SEC + 60 })))).toBeNull();
  expect(await verifyJwt(await token(es, claims({ iss: 'https://evil.example/auth/v1' })))).toBeNull();
  expect(await verifyJwt(await token(es, claims({ aud: 'anon' })))).toBeNull();
  expect((await verifyJwt(await token(es, claims({ aud: ['authenticated', 'other'] }))))?.userId).toBe('u_jane');
  expect(await verifyJwt(await token(es, claims({ sub: '' })))).toBeNull();
  expect(await verifyJwt(await token(es, claims(), { alg: 'HS256' }))).toBeNull();
  expect(await verifyJwt(`${enc({ alg: 'none' })}.${enc(claims())}.`)).toBeNull();
  expect(await verifyJwt('not-a-token')).toBeNull();
  expect(await verifyJwt('')).toBeNull();
});

test('requireUser resolves the app role from the users repo and creates a missing row from the claims', async () => {
  setTestUser(undefined);
  const repos = createMemoryRepos();
  const bearer = await token(es, claims());
  const user = await requireUser(new Request('http://localhost/api/v1/reports', { headers: { authorization: `Bearer ${bearer}` } }), repos);
  expect(user).toEqual({ userId: 'u_jane', role: 'resident' });
  expect(await repos.users.getById('u_jane')).toMatchObject({ display_name: 'Jane Doe', auth_provider: 'apple', role: 'resident' });
  repos.users.seed({ id: 'u_boss', role: 'director' });
  const boss = await requireUser(new Request('http://localhost/x', { headers: { Authorization: `Bearer ${await token(rs, claims({ sub: 'u_boss' }))}` } }), repos);
  expect(boss).toEqual({ userId: 'u_boss', role: 'director' });
  const none = await requireUser(new Request('http://localhost/x'), repos);
  expect(none).toBeInstanceOf(Response);
  expect((none as Response).status).toBe(401);
  const bad = await requireUser(new Request('http://localhost/x', { headers: { authorization: 'Bearer nope' } }), repos);
  expect((bad as Response).status).toBe(401);
});
