/**
 * The API's bearer-token source. A leaf module on purpose: services/apiClient reads the token and services/auth
 * installs the provider, so both import this instead of each other (Metro warned about the auth ↔ apiClient cycle).
 * initAuth() installs the Supabase session getter; tests install their own; signed out it answers null.
 */
export type TokenProvider = () => Promise<string | null>;

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
