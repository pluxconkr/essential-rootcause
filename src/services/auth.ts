/**
 * Auth on the phone (plan §9.3, owner decision D3): accounts are required for every write; browsing needs none.
 * M0: token plumbing only. M1 wires Sign in with Apple, Google and the email code through supabase-js and the
 * S-14 sheet; until then `getAccessToken()` returns null and every write path shows "Sign in to vote".
 */
import type { AuthSession } from '@/domain/types';
import { actions, getState } from '@/store/appStore';

type TokenProvider = () => Promise<string | null>;

let tokenProvider: TokenProvider = async () => null;

/** Installed by the Supabase auth client once it exists (M1). */
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

/** Ask for a session before a write. M0: resolves with the current session (null when signed out). M1 opens S-14. */
export async function requireSession(_reason: 'report' | 'vote' | 'comment' | 'follow' | 'verify'): Promise<AuthSession | null> {
  return currentSession();
}

export async function signOut(): Promise<void> {
  actions.setSession(null);
}
