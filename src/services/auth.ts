/**
 * Auth on the phone (plan §3.4 D3, §9.3, §23.A–E): accounts are required for every write, browsing needs none.
 * Wraps supabase-js (auth only, ./supabaseClient): Sign in with Apple (iOS, native sheet; nonce from expo-crypto —
 * SHA-256 to Apple, the raw value to Supabase), Google (@react-native-google-signin/google-signin → signInWithIdToken)
 * and the 6-digit email code (signInWithOtp → verifyOtp type 'email'). Keeps the M0 exported names (setTokenProvider,
 * getAccessToken, currentSession, isSignedIn, requireSession, signOut) so every caller keeps compiling.
 *
 * requireSession(reason) resolves at once when signed in; otherwise it opens the S-14 sheet (/sign-in) and parks the
 * caller in a module-level registry that the sheet settles — with the session when sign-in completes, with null on
 * "Not now". The store's session profile mirrors supabase's auth state through onAuthStateChange; the app role comes
 * from GET /api/v1/me (plan §3.4: roles live in app_user, not in the token) and defaults to resident.
 * Nothing here throws: every call returns a result object or null.
 */
import type { Session, User } from '@supabase/supabase-js';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { router } from 'expo-router';
import { AppState, Platform } from 'react-native';
import { z } from 'zod';

import { MeProfileSchema, type AuthSession, type MeProfile } from '@/domain/types';
import { t } from '@/i18n';
import { actions, getState, isOfflineNow } from '@/store/appStore';

import { api } from './apiClient';
import { authCallbackUrl, isSignInConfigured, supabase } from './supabaseClient';

export type SignInReason = 'report' | 'vote' | 'comment' | 'follow' | 'verify' | 'watch' | 'staff';
export type SignInErrorCode = 'unavailable' | 'offline' | 'cancelled' | 'invalid_input' | 'invalid_code' | 'provider';
export type SignInResult = { ok: true } | { ok: false; code: SignInErrorCode; message: string };

export const EMAIL_CODE_LENGTH = 6; // spec: plan §23.B 6-digit code; supabase/config.toml otp_length = 6

/** Public configuration (plan §3.4: client ids are not secrets). Android's client id is bound by package + SHA-1 in the Google console, not passed here. */
export const GOOGLE = {
  iosClientId: (process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '').trim(),
  webClientId: (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '').trim(), // also the Android id-token audience (plan §23.E)
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OkSchema = z.object({ ok: z.literal(true) });

// ---------- token plumbing (M0 names) ----------

type TokenProvider = () => Promise<string | null>;

let tokenProvider: TokenProvider = async () => null;

/** Installed by initAuth(); tests install their own. */
export function setTokenProvider(fn: TokenProvider): void {
  tokenProvider = fn;
}

/** Bearer token for the API, or null when signed out. Never throws. */
export async function getAccessToken(): Promise<string | null> {
  try {
    return await tokenProvider();
  } catch {
    return null;
  }
}

export function currentSession(): AuthSession | null {
  return getState().session;
}

export function isSignedIn(): boolean {
  return getState().session != null;
}

// ---------- pending sign-in registry (settled by the S-14 sheet) ----------

type Resolver = (session: AuthSession | null) => void;

let pending: Resolver[] = [];

export function hasPendingSignIn(): boolean {
  return pending.length > 0;
}

/** Resolve every caller waiting on requireSession(): the session when sign-in completed, null when the sheet was dismissed. Safe when nobody waits. */
export function settleSignIn(session: AuthSession | null): void {
  const waiting = pending;
  pending = [];
  for (const resolve of waiting) resolve(session);
}

/**
 * Ask for a session before a write. Resolves immediately when signed in. Otherwise opens the sign-in sheet once (later
 * callers join the same wait) and resolves when the sheet settles. On a build without Supabase configuration nothing
 * can sign in, so it resolves null at once and the caller shows its "Sign in to …" line.
 */
export function requireSession(reason: SignInReason): Promise<AuthSession | null> {
  const current = currentSession();
  if (current) return Promise.resolve(current);
  if (!isSignInConfigured()) return Promise.resolve(null);
  return new Promise((resolve) => {
    pending.push(resolve);
    if (pending.length > 1) return; // the sheet is already open
    try {
      router.push({ pathname: '/sign-in', params: { reason } });
    } catch {
      settleSignIn(null); // no navigator mounted (boot, tests): nobody may wait forever
    }
  });
}

// ---------- session mirror ----------

function providerOf(user: User): AuthSession['provider'] {
  const p = user.app_metadata?.provider;
  return p === 'apple' || p === 'google' ? p : 'email';
}

function nameOf(user: User): string | null {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const raw = typeof meta.full_name === 'string' ? meta.full_name : typeof meta.name === 'string' ? meta.name : '';
  return raw.trim() || null;
}

/** Mirror a supabase session into the store (disk first). Keeps the role and name already learned from /me for the same user. */
export function applySession(session: Session | null): AuthSession | null {
  const prev = getState().session;
  if (!session) {
    if (prev) actions.setSession(null);
    return null;
  }
  const same = prev?.userId === session.user.id ? prev : null;
  const next: AuthSession = {
    userId: session.user.id,
    role: same?.role ?? 'resident',
    displayName: same?.displayName ?? nameOf(session.user),
    email: session.user.email ?? null,
    provider: providerOf(session.user),
  };
  if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) actions.setSession(next);
  return next;
}

/** GET /api/v1/me → role and display name into the store. Null offline, signed out or on any failure. */
export async function refreshProfile(): Promise<MeProfile | null> {
  if (isOfflineNow() || !isSignedIn()) return null;
  const res = await api('/api/v1/me', MeProfileSchema);
  if (!res.ok) return null;
  const cur = getState().session;
  if (cur && cur.userId === res.data.userId) actions.setSession({ ...cur, role: res.data.role, displayName: res.data.displayName ?? cur.displayName, email: res.data.email ?? cur.email });
  return res.data;
}

let stopAuth: (() => void) | null = null;

/**
 * Boot wiring (call once from the root layout): installs the token provider, mirrors auth state changes into the store,
 * settles waiting callers after a sign-in and pauses token refresh while the app is in the background. Idempotent;
 * returns the stop function. Without Supabase configuration it only installs the signed-out provider.
 */
export function initAuth(): () => void {
  if (stopAuth) return stopAuth;
  if (!supabase) {
    setTokenProvider(async () => null);
    stopAuth = () => {
      stopAuth = null;
    };
    return stopAuth;
  }
  const client = supabase;
  setTokenProvider(async () => (await client.auth.getSession()).data.session?.access_token ?? null);
  const { data } = client.auth.onAuthStateChange((event, session) => {
    const local = applySession(session);
    if (!local || (event !== 'SIGNED_IN' && event !== 'INITIAL_SESSION')) return;
    // Other auth calls inside this callback deadlock (supabase-js docs), and settled callers go straight to api() → getSession():
    // hand them the session on the next tick, then learn the role.
    setTimeout(() => {
      settleSignIn(local);
      void refreshProfile();
    }, 0);
  });
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') client.auth.startAutoRefresh();
    else client.auth.stopAutoRefresh();
  });
  stopAuth = () => {
    data.subscription.unsubscribe();
    appState.remove();
    stopAuth = null;
  };
  return stopAuth;
}

// ---------- providers ----------

function unavailable(message = 'Sign-in is not configured on this build.'): SignInResult {
  return { ok: false, code: 'unavailable', message };
}

function offline(): SignInResult {
  return { ok: false, code: 'offline', message: 'Sign-in needs a connection. Your drafts are saved on this phone.' };
}

function failed(message = t('signIn.failed')): SignInResult {
  return { ok: false, code: 'provider', message };
}

function isCancel(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code ?? '';
  return code === 'ERR_REQUEST_CANCELED' || code === 'ERR_CANCELED' || /cancel/i.test(code);
}

/** 32 random bytes as hex: the raw nonce Supabase hashes and compares with the `nonce` claim Apple put in the token. */
export function randomNonce(): string {
  return Array.from(Crypto.getRandomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Plan §23.C/§23.E follow-ups after an Apple sign-in: link the authorization code within 5 minutes; send the name Apple gives only once. */
async function afterAppleSignIn(credential: AppleAuthentication.AppleAuthenticationCredential): Promise<void> {
  if (credential.authorizationCode) {
    const linked = await api('/api/v1/me/apple-link', OkSchema, { method: 'POST', body: { authorizationCode: credential.authorizationCode } });
    if (!linked.ok && __DEV__) console.warn('[auth] apple-link failed', linked.code);
  }
  const name = [credential.fullName?.givenName, credential.fullName?.familyName].filter((s): s is string => !!s && s.trim().length > 0).join(' ').trim();
  if (name) await api('/api/v1/me', MeProfileSchema, { method: 'PATCH', body: { displayName: name } });
  await refreshProfile();
}

/** Sign in with Apple — iOS only (plan §23.E: Guideline 4.8 binds iOS; Android is not offered Apple). */
export async function signInWithApple(): Promise<SignInResult> {
  if (!supabase) return unavailable();
  if (Platform.OS !== 'ios') return unavailable('Sign in with Apple is available on iPhone only.');
  if (isOfflineNow()) return offline();
  try {
    const rawNonce = randomNonce();
    const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: hashedNonce,
    });
    if (!credential.identityToken) return failed();
    const { error } = await supabase.auth.signInWithIdToken({ provider: 'apple', token: credential.identityToken, nonce: rawNonce });
    if (error) return failed(error.message);
    void afterAppleSignIn(credential);
    return { ok: true };
  } catch (e) {
    return isCancel(e) ? { ok: false, code: 'cancelled', message: 'Sign-in cancelled. Nothing was sent.' } : failed();
  }
}

/** Google — iOS and Android through the native SDK. Web: TODO(M2) Google Identity Services id token → signInWithIdToken (plan §23.E web console row). */
export async function signInWithGoogle(): Promise<SignInResult> {
  if (!supabase) return unavailable();
  if (Platform.OS === 'web') return unavailable('Google sign-in on the web arrives in the next build. Use an email code.');
  if (isOfflineNow()) return offline();
  try {
    // Loaded on demand: the package requires its native module at import time, which neither the web bundle nor tests have.
    const google = await import('@react-native-google-signin/google-signin');
    google.GoogleSignin.configure({ iosClientId: GOOGLE.iosClientId || undefined, webClientId: GOOGLE.webClientId || undefined });
    await google.GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const response = await google.GoogleSignin.signIn();
    if (!google.isSuccessResponse(response)) return { ok: false, code: 'cancelled', message: 'Sign-in cancelled. Nothing was sent.' };
    const idToken = response.data.idToken;
    if (!idToken) return failed('Google did not return an id token. Check the client ids in the build.');
    const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
    if (error) return failed(error.message);
    return { ok: true };
  } catch (e) {
    if (isCancel(e)) return { ok: false, code: 'cancelled', message: 'Sign-in cancelled. Nothing was sent.' };
    return unavailable('Google sign-in is not available on this build.');
  }
}

/** Step 1 of the email path: send a 6-digit code (plan §23.B: Resend SMTP, template shows {{ .Token }}, 600 s expiry). */
export async function sendEmailCode(email: string): Promise<SignInResult> {
  if (!supabase) return unavailable();
  const clean = email.trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) return { ok: false, code: 'invalid_input', message: 'Enter the email address the code should go to.' };
  if (isOfflineNow()) return offline();
  const { error } = await supabase.auth.signInWithOtp({ email: clean, options: { shouldCreateUser: true, emailRedirectTo: authCallbackUrl() } });
  if (error) {
    const limited = error.status === 429 || /rate.?limit/i.test(error.code ?? '');
    return failed(limited ? 'Too many codes were requested for this address. Wait a few minutes and try again.' : error.message);
  }
  return { ok: true };
}

/** Step 2: the code typed in the app. */
export async function verifyEmailCode(email: string, code: string): Promise<SignInResult> {
  if (!supabase) return unavailable();
  const clean = email.trim().toLowerCase();
  const digits = code.replace(/\D/g, '');
  if (digits.length !== EMAIL_CODE_LENGTH) return { ok: false, code: 'invalid_code', message: `Enter the ${EMAIL_CODE_LENGTH}-digit code from the email.` };
  if (isOfflineNow()) return offline();
  const { error } = await supabase.auth.verifyOtp({ email: clean, token: digits, type: 'email' });
  if (error) return { ok: false, code: 'invalid_code', message: 'That code did not work. Check the digits or request a new one — codes expire after 10 minutes.' };
  return { ok: true };
}

// ---------- email link (deep link rootcause://auth/callback, plan §3.4) ----------

export type AuthLink = { kind: 'code'; code: string } | { kind: 'token_hash'; tokenHash: string; type: string } | { kind: 'tokens'; accessToken: string; refreshToken: string } | { kind: 'error'; message: string };

/** What a Supabase email link carries: a PKCE `code`, a `token_hash` + `type`, or implicit-flow tokens in the fragment. Null when nothing auth-related is there. */
export function parseAuthLink(url: string | null | undefined): AuthLink | null {
  if (!url) return null;
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  const query = new URLSearchParams(q >= 0 ? url.slice(q + 1, h > q ? h : undefined) : '');
  const fragment = new URLSearchParams(h >= 0 ? url.slice(h + 1) : '');
  const get = (k: string) => fragment.get(k) ?? query.get(k);
  const errorDescription = get('error_description') ?? get('error');
  if (errorDescription) return { kind: 'error', message: errorDescription.replace(/\+/g, ' ') };
  const code = get('code');
  if (code) return { kind: 'code', code };
  const tokenHash = get('token_hash');
  if (tokenHash) return { kind: 'token_hash', tokenHash, type: get('type') ?? 'email' };
  const accessToken = get('access_token');
  const refreshToken = get('refresh_token');
  if (accessToken && refreshToken) return { kind: 'tokens', accessToken, refreshToken };
  return null;
}

/** Finish a sign-in started by an email link. The auth state listener mirrors the resulting session into the store. */
export async function completeSignInFromLink(link: AuthLink): Promise<SignInResult> {
  if (!supabase) return unavailable();
  if (link.kind === 'error') return failed(link.message);
  if (isOfflineNow()) return offline();
  try {
    const { error } =
      link.kind === 'code'
        ? await supabase.auth.exchangeCodeForSession(link.code)
        : link.kind === 'token_hash'
          ? await supabase.auth.verifyOtp({ token_hash: link.tokenHash, type: link.type as 'email' })
          : await supabase.auth.setSession({ access_token: link.accessToken, refresh_token: link.refreshToken });
    return error ? failed(error.message) : { ok: true };
  } catch {
    return failed();
  }
}

// ---------- sign out / delete ----------

/** Sign out everywhere when online, locally when not; the store is cleared either way. */
export async function signOut(): Promise<void> {
  if (supabase) {
    try {
      const { error } = await supabase.auth.signOut({ scope: isOfflineNow() ? 'local' : 'global' });
      if (error) await supabase.auth.signOut({ scope: 'local' });
    } catch {
      /* the local session is cleared below regardless */
    }
  }
  actions.setSession(null);
}

/** DELETE /api/v1/me (de-identify + delete the auth user, plan §23.C) then sign out — the App Store account-deletion path. */
export async function deleteMyData(): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isSignedIn()) return { ok: false, message: 'You are not signed in.' };
  if (isOfflineNow()) return { ok: false, message: 'Deleting your data needs a connection. Nothing was changed.' };
  const res = await api('/api/v1/me', z.null(), { method: 'DELETE' });
  if (!res.ok) return { ok: false, message: res.message };
  // The auth user is gone, so only the local copy of the session can be cleared.
  try {
    await supabase?.auth.signOut({ scope: 'local' });
  } catch {
    /* nothing left to clear */
  }
  actions.setSession(null);
  return { ok: true };
}
