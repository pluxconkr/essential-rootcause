/**
 * Supabase service-role client for the API routes (plan §3.1: the routes are the only API and talk to Supabase with
 * the service key; RLS stays on for everyone else, §6). Fails closed: createServiceClient() throws ConfigError when
 * the env is missing so the route answers 503 (§3.10) rather than running against nothing. No session persistence
 * and no auto-refresh — this is a server, not a browser. The cached client is best-effort only: workerd keeps no
 * memory between requests (§3.10), so every call site must work with a fresh client too. Server-only module.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getServerEnv } from './env';

export type ServiceClient = SupabaseClient;

export function createServiceClient(): ServiceClient {
  const env = getServerEnv();
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

let cached: ServiceClient | null = null;

/** One client per isolate; throws ConfigError when the env is missing. */
export function getServiceClient(): ServiceClient {
  if (!cached) cached = createServiceClient();
  return cached;
}

/** Tests and key rotation drop the cached client. */
export function resetServiceClient(): void {
  cached = null;
}
