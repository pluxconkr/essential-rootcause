/**
 * Session verification and capabilities for the API routes (plan §3.4, §7, §12 "Supabase JWT verified (JWKS cached);
 * capability matrix per route; every write without a session → 401").
 *
 * verifyJwt() checks a Supabase access token without any JWT library: it decodes the compact JWS, fetches the project's
 * JWKS at `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, verifies RS256 / ES256 with WebCrypto subtle.verify and
 * then checks exp, iss and aud. The JWKS cache is an in-module variable refreshed on a key-id miss — best-effort only,
 * because the workerd runtime keeps no memory between requests (plan §3.10). HS256 tokens are refused: the shared
 * secret must never be on this server.
 *
 * The app role comes from the users repo (app_user.role), not from the token. requireUser() returns the signed-in
 * user or a ready 401 Response; requireCapability() returns a 403 Response or null. Tests bypass verification with
 * setTestUser(), which is honoured only when NODE_ENV === 'test'. Server-only module.
 */
import { can, type Action } from '@/domain/roles';
import type { Role } from '@/domain/types';

import { getServerEnv } from './env';
import { error, readBearer } from './http';
import { logEvent } from './log';
import type { AuthProfile, AuthProvider, Repos } from './repos/types';

export interface AuthedUser {
  userId: string;
  role: Role;
}

export interface JwtClaims {
  sub: string;
  exp: number;
  iat?: number;
  iss?: string;
  aud?: string | string[];
  email?: string;
  role?: string;
  app_metadata?: { provider?: string };
  user_metadata?: { full_name?: string; name?: string };
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

interface JwksCache {
  keys: Jwk[];
  fetchedAt: number;
}

export const JWKS_TTL_MS = 10 * 60_000;
export const CLOCK_SKEW_SEC = 60;
const SUPPORTED_ALGS = ['RS256', 'ES256'] as const;
type Alg = (typeof SUPPORTED_ALGS)[number];

let jwksCache: JwksCache | null = null;
let testUser: AuthedUser | null | undefined;

// ---------- base64url / JWKS ----------

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodePart(s: string): unknown {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

export function jwksUrl(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`;
}

async function fetchJwks(url: string): Promise<Jwk[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  return Array.isArray(body.keys) ? (body.keys as Jwk[]) : [];
}

async function findKey(kid: string | undefined, alg: Alg, url: string): Promise<Jwk | null> {
  const matches = (keys: Jwk[]) => keys.find((k) => (kid ? k.kid === kid : true) && (!k.alg || k.alg === alg)) ?? null;
  const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (fresh) {
    const hit = matches(jwksCache!.keys);
    if (hit) return hit;
  }
  // Miss or stale: refresh once (key rotation) — the only network call on this path.
  const keys = await fetchJwks(url);
  jwksCache = { keys, fetchedAt: Date.now() };
  return matches(keys);
}

function importParams(alg: Alg): { imp: RsaHashedImportParams | EcKeyImportParams; verify: AlgorithmIdentifier | EcdsaParams } {
  return alg === 'RS256'
    ? { imp: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } }
    : { imp: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } };
}

// ---------- verification ----------

/** Resolves {userId, claims} for a valid Supabase access token, null for anything else. Never throws (ConfigError aside). */
export async function verifyJwt(token: string): Promise<{ userId: string; claims: JwtClaims } | null> {
  const env = getServerEnv();
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const header = decodePart(h) as { alg?: string; kid?: string; typ?: string };
    if (!SUPPORTED_ALGS.includes(header.alg as Alg)) return null;
    const alg = header.alg as Alg;
    const jwk = await findKey(header.kid, alg, jwksUrl(env.supabaseUrl));
    if (!jwk) return null;
    const { imp, verify } = importParams(alg);
    const { kid: _kid, ...keyData } = jwk;
    const key = await crypto.subtle.importKey('jwk', keyData, imp, false, ['verify']);
    const ok = await crypto.subtle.verify(verify, key, b64urlToBytes(s) as BufferSource, new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;

    const claims = decodePart(p) as JwtClaims;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) return null;
    if (typeof claims.exp !== 'number' || claims.exp <= now - CLOCK_SKEW_SEC) return null;
    if (typeof claims.iat === 'number' && claims.iat > now + CLOCK_SKEW_SEC) return null;
    if (claims.iss !== `${env.supabaseUrl}/auth/v1`) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!aud.includes('authenticated')) return null;
    return { userId: claims.sub, claims };
  } catch (e) {
    logEvent('warn', 'auth.verify_failed', { error: e instanceof Error ? e : new Error(String(e)) });
    return null;
  }
}

function providerOf(claims: JwtClaims): AuthProvider | null {
  const p = claims.app_metadata?.provider;
  return p === 'apple' || p === 'google' || p === 'email' ? p : null;
}

export function profileFromClaims(claims: JwtClaims): AuthProfile {
  return { id: claims.sub, displayName: claims.user_metadata?.full_name?.trim() || claims.user_metadata?.name?.trim() || null, provider: providerOf(claims), email: claims.email?.trim().toLowerCase() || null };
}

/** The signed-in user (role from app_user) or a 401 Response ready to return. */
export async function requireUser(request: Request, repos: Repos): Promise<AuthedUser | Response> {
  if (testUser !== undefined && process.env.NODE_ENV === 'test') return testUser ?? error(401, 'unauthenticated', 'Sign in to continue.');
  const token = readBearer(request);
  if (!token) return error(401, 'unauthenticated', 'Sign in to continue.');
  const verified = await verifyJwt(token);
  if (!verified) return error(401, 'unauthenticated', 'Your session has expired. Sign in again.');
  const row = (await repos.users.getById(verified.userId)) ?? (await repos.users.upsertFromAuth(profileFromClaims(verified.claims)));
  return { userId: row.id, role: row.role };
}

/** null when the role may perform `action` (domain/roles capability matrix), else a 403 Response. Auditors write nothing (plan §12). */
export function requireCapability(user: AuthedUser, action: Action): Response | null {
  return can(user.role, action) ? null : error(403, 'forbidden', 'Your account cannot do that.');
}

/** Tests: an AuthedUser signs every request, null forces "no session", undefined restores real verification. */
export function setTestUser(user: AuthedUser | null | undefined): void {
  testUser = user;
}

/** Tests and key rotation. */
export function resetJwksCache(): void {
  jwksCache = null;
}
