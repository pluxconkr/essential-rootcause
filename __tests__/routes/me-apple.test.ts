/**
 * src/server/apple.ts (plan §23.C): the ES256 client secret verifies against the key's public half and carries the
 * claims Apple documents; the exchange and revoke calls send the documented form fields and map every outcome
 * without throwing; sealed refresh tokens round-trip and refuse tampering or another key; missing env fails closed.
 */
import { APPLE, appleEnv, exchangeAppleCode, mintClientSecret, openToken, revokeApple, sealToken, type AppleEnv } from '@/server/apple';
import { setLogSink } from '@/server/log';

const ENV_KEYS = ['APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY', 'APPLE_CLIENT_ID'];
const saved: Record<string, string | undefined> = {};

interface TestKey {
  env: AppleEnv;
  publicKey: CryptoKey;
}

async function generate(): Promise<TestKey> {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key.privateKey));
  const b64 = btoa(String.fromCharCode(...der));
  const pem = `-----BEGIN PRIVATE KEY-----\n${(b64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----`;
  return { env: { teamId: 'TEAM123456', keyId: 'KEY1234567', privateKeyPem: pem, clientId: APPLE.defaultClientId }, publicKey: key.publicKey };
}

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const decode = (s: string) => JSON.parse(new TextDecoder().decode(fromB64url(s)));

function setEnv(env: AppleEnv | null) {
  for (const k of ENV_KEYS) delete process.env[k];
  if (!env) return;
  process.env.APPLE_TEAM_ID = env.teamId;
  process.env.APPLE_KEY_ID = env.keyId;
  process.env.APPLE_PRIVATE_KEY = env.privateKeyPem;
}

let key: TestKey;

beforeAll(async () => {
  setLogSink(() => {});
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  key = await generate();
});

afterAll(() => {
  setLogSink(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => setEnv(null));

test('appleEnv: null until all three secrets exist; the bundle id is the default client id; EAS "\\n" sequences are unescaped', () => {
  expect(appleEnv()).toBeNull();
  process.env.APPLE_TEAM_ID = 'TEAM123456';
  process.env.APPLE_KEY_ID = 'KEY1234567';
  expect(appleEnv()).toBeNull();
  process.env.APPLE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nMIGH\\n-----END PRIVATE KEY-----';
  expect(appleEnv()).toEqual({ teamId: 'TEAM123456', keyId: 'KEY1234567', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nMIGH\n-----END PRIVATE KEY-----', clientId: 'com.27363.rootcause' });
  process.env.APPLE_CLIENT_ID = 'com.27363.rootcause.dev';
  expect(appleEnv()?.clientId).toBe('com.27363.rootcause.dev');
});

test('mintClientSecret: ES256 JWT with Apple\'s claims, 5-minute life, verifiable with the public key', async () => {
  const nowMs = Date.parse('2026-10-05T12:00:00.000Z');
  const jwt = await mintClientSecret(key.env, nowMs);
  const [h, p, s] = jwt.split('.');
  expect(decode(h)).toEqual({ alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  const payload = decode(p);
  expect(payload).toEqual({ iss: 'TEAM123456', iat: nowMs / 1000, exp: nowMs / 1000 + APPLE.clientSecretTtlSec, aud: 'https://appleid.apple.com', sub: 'com.27363.rootcause' });
  expect(fromB64url(s)).toHaveLength(64); // r‖s, as JWS wants it — no DER wrapping
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key.publicKey, fromB64url(s) as BufferSource, new TextEncoder().encode(`${h}.${p}`));
  expect(ok).toBe(true);
  const other = await generate();
  expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, other.publicKey, fromB64url(s) as BufferSource, new TextEncoder().encode(`${h}.${p}`))).toBe(false);
});

test('exchangeAppleCode: unconfigured → rejected → ok → unreachable, with the documented form fields', async () => {
  expect(await exchangeAppleCode('c0de')).toEqual({ ok: false, reason: 'unconfigured' });
  setEnv(key.env);
  const calls: { url: string; body: URLSearchParams }[] = [];
  const answers: (Response | Error)[] = [new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }), new Response(JSON.stringify({ refresh_token: 'r_1' }), { status: 200 }), new Response(JSON.stringify({ no_refresh: true }), { status: 200 }), new Error('offline')];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body)) });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next!;
  }) as typeof fetch;
  expect(await exchangeAppleCode('expired', fetchImpl)).toEqual({ ok: false, reason: 'rejected' });
  expect(await exchangeAppleCode('c0de', fetchImpl)).toEqual({ ok: true, refreshToken: 'r_1' });
  expect(await exchangeAppleCode('c0de', fetchImpl)).toEqual({ ok: false, reason: 'rejected' });
  expect(await exchangeAppleCode('c0de', fetchImpl)).toEqual({ ok: false, reason: 'unreachable' });
  expect(calls[1].url).toBe(APPLE.tokenUrl);
  expect(Object.fromEntries(calls[1].body)).toMatchObject({ grant_type: 'authorization_code', code: 'c0de', client_id: 'com.27363.rootcause' });
  expect(calls[1].body.get('client_secret')?.split('.')).toHaveLength(3);
});

test('exchangeAppleCode with a broken private key is "unconfigured", not a throw', async () => {
  setEnv({ ...key.env, privateKeyPem: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' });
  const fetchImpl = jest.fn() as unknown as typeof fetch;
  expect(await exchangeAppleCode('c0de', fetchImpl)).toEqual({ ok: false, reason: 'unconfigured' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('revokeApple: true on 200, false otherwise, never throws', async () => {
  expect(await revokeApple('r_1')).toBe(false);
  setEnv(key.env);
  const seen: URLSearchParams[] = [];
  const ok = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new URLSearchParams(String(init?.body)));
    return new Response('', { status: 200 });
  }) as typeof fetch;
  expect(await revokeApple('r_1', ok)).toBe(true);
  expect(Object.fromEntries(seen[0])).toMatchObject({ token: 'r_1', token_type_hint: 'refresh_token', client_id: 'com.27363.rootcause' });
  expect(await revokeApple('r_1', (async () => new Response('', { status: 400 })) as typeof fetch)).toBe(false);
  expect(
    await revokeApple('r_1', (async () => {
      throw new Error('offline');
    }) as typeof fetch),
  ).toBe(false);
});

test('sealToken/openToken: round trip, fresh IV per call, tamper- and key-bound, null without configuration', async () => {
  expect(await sealToken('r_1', null)).toBeNull();
  expect(await openToken('v1.x.y', null)).toBeNull();
  const a = await sealToken('r_refresh_123', key.env);
  const b = await sealToken('r_refresh_123', key.env);
  expect(a).not.toBeNull();
  expect(a).not.toBe(b);
  expect(a).not.toContain('r_refresh_123');
  expect(a!.split('.')).toHaveLength(3);
  expect(await openToken(a!, key.env)).toBe('r_refresh_123');
  const [v, iv, ct] = a!.split('.');
  expect(await openToken(`${v}.${iv}.${ct.slice(0, -2)}AA`, key.env)).toBeNull();
  expect(await openToken('garbage', key.env)).toBeNull();
  expect(await openToken(a!, (await generate()).env)).toBeNull();
  setEnv(key.env);
  expect(await openToken(a!)).toBe('r_refresh_123');
});
