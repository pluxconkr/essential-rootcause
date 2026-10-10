/**
 * The phone's Supabase client — auth only (plan §3.1: every read and write goes through the API routes, never
 * supabase-js; §4 flow 1: the session lives in kv through a custom storage adapter). Built from public configuration,
 * EXPO_PUBLIC_SUPABASE_URL + EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY (plan §23.J; the legacy anon JWT is accepted in the
 * same argument). `supabase` is null when either value is missing, so a build without auth configuration runs
 * signed-out instead of crashing — every caller checks for null (services never throw).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

import { kv } from '@/data/kv';

export const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
export const SUPABASE_PUBLISHABLE_KEY = (process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '').trim();

/** kv namespace for the auth tokens; `session:v1` (src/data/repos.ts) holds the profile the UI reads, never the tokens. */
export const AUTH_KV_PREFIX = 'auth:';

/**
 * Drop everything supabase-js persisted (session, split user, PKCE verifiers). auth-js refuses to clear an expired
 * session it cannot refresh (a retryable fetch error keeps it), so an offline sign-out and the local-data reset must do
 * it themselves. The `sb-` prefix leaves the app's own `auth:pending:v1` record alone.
 */
export function clearAuthStorage(): void {
  for (const k of kv.keys()) if (k.startsWith(`${AUTH_KV_PREFIX}sb-`)) kv.remove(k);
}

/** supabase-js storage adapter over the synchronous kv store: strings in, strings out, nothing thrown. */
export const kvAuthStorage = {
  async getItem(key: string): Promise<string | null> {
    const v = kv.get<string>(AUTH_KV_PREFIX + key);
    return typeof v === 'string' ? v : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    kv.set(AUTH_KV_PREFIX + key, value);
  },
  async removeItem(key: string): Promise<void> {
    kv.remove(AUTH_KV_PREFIX + key);
  },
};

export function createAuthClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, {
    auth: {
      storage: kvAuthStorage,
      persistSession: true,
      autoRefreshToken: true, // plan §9.2: a 401 is retried after a token refresh; the client keeps the token fresh itself
      // Native deep links are handled by src/app/auth/callback.tsx; on the web the same screen does it, so no auto-detection anywhere.
      detectSessionInUrl: false,
      // PKCE: an email link carries a one-time `code` that only this device's stored verifier can redeem, so a link forged
      // or forwarded by someone else cannot sign this phone into their account (login CSRF / session fixation).
      flowType: 'pkce',
    },
  });
}

/** null when the build carries no Supabase configuration: sign-in is unavailable and the app runs signed-out. */
export const supabase: SupabaseClient | null = SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY ? createAuthClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY) : null;

export function isSignInConfigured(): boolean {
  return supabase !== null;
}

/** Where the email link variant lands (plan §3.4, §23.B): the app scheme on the phone, this origin on the web. */
export function authCallbackUrl(): string | undefined {
  if (Platform.OS !== 'web') return 'rootcause://auth/callback';
  return typeof window !== 'undefined' && window.location?.origin ? `${window.location.origin}/auth/callback` : undefined;
}
