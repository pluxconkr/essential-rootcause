/**
 * Sign in with Apple, server side (plan §23.C): right after sign-in the app posts its `authorizationCode`, which is
 * exchanged here for a refresh token; when the account is deleted that token is revoked — Apple requires revocation
 * on deletion. The client secret is an ES256 JWT minted per call with WebCrypto from APPLE_TEAM_ID / APPLE_KEY_ID /
 * APPLE_PRIVATE_KEY (the .p8 contents; server env only, never logged). The refresh token is stored sealed
 * (AES-256-GCM under a key derived from the Apple private key) so a database dump alone cannot revoke or replay it.
 * Nothing here throws: results are objects or booleans, failures are logged without the token. Server-only module.
 */
import { logEvent } from './log';

export const APPLE = {
  tokenUrl: 'https://appleid.apple.com/auth/token', // spec: plan §23.C exchange endpoint
  revokeUrl: 'https://appleid.apple.com/auth/revoke', // spec: plan §23.C revoke endpoint
  audience: 'https://appleid.apple.com', // Apple "Generate and validate tokens": client secret `aud`
  clientSecretTtlSec: 300, // minted per call, so five minutes is plenty (Apple allows up to six months)
  defaultClientId: 'com.27363.rootcause', // app.json ios.bundleIdentifier — the native flow's client id (plan §23.E)
  timeoutMs: 8_000,
} as const;

export interface AppleEnv {
  teamId: string;
  keyId: string;
  /** PKCS#8 PEM (the downloaded .p8). */
  privateKeyPem: string;
  clientId: string;
}

export type AppleExchange = { ok: true; refreshToken: string } | { ok: false; reason: 'unconfigured' | 'rejected' | 'unreachable' };

const enc = new TextEncoder();

function str(v: string | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/** The Apple configuration, or null when any secret is absent — the routes answer 503 then (fail closed, plan §3.10). */
export function appleEnv(): AppleEnv | null {
  const teamId = str(process.env.APPLE_TEAM_ID);
  const keyId = str(process.env.APPLE_KEY_ID);
  const pem = str(process.env.APPLE_PRIVATE_KEY);
  if (!teamId || !keyId || !pem) return null;
  // EAS stores multi-line secrets with literal "\n" sequences.
  return { teamId, keyId, privateKeyPem: pem.replace(/\\n/g, '\n'), clientId: str(process.env.APPLE_CLIENT_ID) ?? APPLE.defaultClientId };
}

// ---------- encoding ----------

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pemToDer(pem: string): Uint8Array {
  return fromB64(pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, ''));
}

// ---------- client secret ----------

/** ES256 JWT {iss: team, sub: client id, aud: appleid.apple.com, iat, exp} signed with the .p8 key. WebCrypto's ECDSA output is already the r‖s form JWS wants. */
export async function mintClientSecret(env: AppleEnv, nowMs: number = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(env.privateKeyPem) as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: env.keyId, typ: 'JWT' })));
  const payload = b64url(enc.encode(JSON.stringify({ iss: env.teamId, iat, exp: iat + APPLE.clientSecretTtlSec, aud: APPLE.audience, sub: env.clientId })));
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(signature)}`;
}

async function appleForm(url: string, fields: Record<string, string>, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(APPLE.timeoutMs),
  });
}

// ---------- exchange / revoke ----------

/** authorizationCode → refresh token. 'rejected' = Apple said no (expired code, wrong client id); 'unreachable' = no answer. */
export async function exchangeAppleCode(code: string, fetchImpl: typeof fetch = fetch): Promise<AppleExchange> {
  const env = appleEnv();
  if (!env) return { ok: false, reason: 'unconfigured' };
  let secret: string;
  try {
    secret = await mintClientSecret(env);
  } catch (e) {
    logEvent('error', 'apple.key_invalid', { error: e instanceof Error ? e : new Error(String(e)) });
    return { ok: false, reason: 'unconfigured' };
  }
  try {
    const res = await appleForm(APPLE.tokenUrl, { grant_type: 'authorization_code', code, client_id: env.clientId, client_secret: secret }, fetchImpl);
    if (!res.ok) {
      logEvent('warn', 'apple.exchange_rejected', { status: res.status });
      return { ok: false, reason: 'rejected' };
    }
    const data = (await res.json()) as { refresh_token?: unknown };
    if (typeof data.refresh_token !== 'string' || data.refresh_token.length === 0) return { ok: false, reason: 'rejected' };
    return { ok: true, refreshToken: data.refresh_token };
  } catch (e) {
    logEvent('warn', 'apple.exchange_failed', { error: e instanceof Error ? e : new Error(String(e)) });
    return { ok: false, reason: 'unreachable' };
  }
}

/** Best effort (plan §23.C "revoke … best-effort, logged"): true when Apple answered 200. */
export async function revokeApple(refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const env = appleEnv();
  if (!env) {
    logEvent('warn', 'apple.revoke_skipped', { reason: 'unconfigured' });
    return false;
  }
  try {
    const secret = await mintClientSecret(env);
    const res = await appleForm(APPLE.revokeUrl, { client_id: env.clientId, client_secret: secret, token: refreshToken, token_type_hint: 'refresh_token' }, fetchImpl);
    if (!res.ok) logEvent('warn', 'apple.revoke_rejected', { status: res.status });
    return res.ok;
  } catch (e) {
    logEvent('warn', 'apple.revoke_failed', { error: e instanceof Error ? e : new Error(String(e)) });
    return false;
  }
}

// ---------- sealing (app_user.apple_refresh_token is "app-level encrypted", migration 0001) ----------

async function sealingKey(env: AppleEnv): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`rootcause:apple-refresh:${env.privateKeyPem}`));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** "v1.<iv>.<ciphertext>" (base64url), or null without Apple configuration. */
export async function sealToken(plain: string, env: AppleEnv | null = appleEnv()): Promise<string | null> {
  if (!env) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await sealingKey(env);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

/** The plain refresh token, or null when the value is not ours, was sealed under another key, or Apple is not configured. */
export async function openToken(sealed: string, env: AppleEnv | null = appleEnv()): Promise<string | null> {
  if (!env) return null;
  const [version, iv, ct] = sealed.split('.');
  if (version !== 'v1' || !iv || !ct) return null;
  try {
    const key = await sealingKey(env);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) as BufferSource }, key, fromB64(ct) as BufferSource);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
