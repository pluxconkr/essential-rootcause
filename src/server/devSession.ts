/**
 * Developer sign-in for the simulator and rehearsals while the project's e-mail delivery is not set up (Supabase's
 * built-in SMTP sends two e-mails an hour and refuses reserved domains; plan §23.B wants Resend before the demo).
 * Only the dev-memory server answers (ROOTCAUSE_DEV_MEMORY=1 and ROOTCAUSE_DEV_SESSION=1, never NODE_ENV=production;
 * the route is a 404 otherwise, so no production build carries it), and only for throwaway addresses under
 * DEV_SESSION_DOMAIN — the accounts are real Auth users on the project, so a laptop on a shared network must not be
 * able to mint a session for someone else's address. The account is upserted through the Auth admin API with a
 * fresh random password each time and signed in with the password grant; the tokens go back to the phone, which
 * hands them to supabase.auth.setSession, so the rest of the app (JWKS verification, /me, votes) runs unchanged.
 * Server-only module.
 */
import { getServerEnv, isConfigured } from './env';
import { logEvent } from './log';

export const DEV_SESSION_DOMAIN = 'e2e.rootcause.app'; // spec: throwaway accounts only — never a real person's address
export const DEV_SESSION_DEFAULT_EMAIL = `sim.tester@${DEV_SESSION_DOMAIN}`;

export type DevSessionResult = { ok: true; accessToken: string; refreshToken: string; email: string } | { ok: false; status: number; message: string };

export function devSessionEnabled(): boolean {
  return process.env.ROOTCAUSE_DEV_MEMORY === '1' && process.env.ROOTCAUSE_DEV_SESSION === '1' && process.env.NODE_ENV !== 'production' && isConfigured();
}

export function isDevSessionEmail(email: string): boolean {
  const clean = email.trim().toLowerCase();
  return /^[a-z0-9._+-]+@[a-z0-9.-]+$/.test(clean) && clean.endsWith(`@${DEV_SESSION_DOMAIN}`);
}

function randomPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `Dev-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Upsert the throwaway account and sign it in. `fetchImpl` is injectable for tests; nothing here throws. */
export async function mintDevSession(email: string, displayName: string, fetchImpl: typeof fetch = fetch): Promise<DevSessionResult> {
  const clean = email.trim().toLowerCase();
  if (!isDevSessionEmail(clean)) return { ok: false, status: 400, message: `Developer sign-in only works for addresses under @${DEV_SESSION_DOMAIN}.` };
  const env = getServerEnv();
  const publishable = (process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '').trim();
  if (!publishable) return { ok: false, status: 503, message: 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set on the dev server.' };
  const base = env.supabaseUrl;
  const admin = { apikey: env.supabaseServiceRoleKey, authorization: `Bearer ${env.supabaseServiceRoleKey}`, 'content-type': 'application/json' };
  const password = randomPassword();
  try {
    const list = await fetchImpl(`${base}/auth/v1/admin/users?page=1&per_page=200`, { headers: admin });
    if (!list.ok) return { ok: false, status: 502, message: `Auth admin list failed (${list.status}).` };
    const users = ((await list.json()) as { users?: { id: string; email?: string }[] }).users ?? [];
    const existing = users.find((u) => u.email?.toLowerCase() === clean);
    const upsert = existing
      ? await fetchImpl(`${base}/auth/v1/admin/users/${existing.id}`, { method: 'PUT', headers: admin, body: JSON.stringify({ password, email_confirm: true }) })
      : await fetchImpl(`${base}/auth/v1/admin/users`, { method: 'POST', headers: admin, body: JSON.stringify({ email: clean, password, email_confirm: true, user_metadata: { full_name: displayName } }) });
    if (!upsert.ok) return { ok: false, status: 502, message: `Auth admin ${existing ? 'update' : 'create'} failed (${upsert.status}).` };
    const token = await fetchImpl(`${base}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: publishable, 'content-type': 'application/json' }, body: JSON.stringify({ email: clean, password }) });
    const body = (await token.json()) as { access_token?: string; refresh_token?: string; error_description?: string; msg?: string };
    if (!token.ok || !body.access_token || !body.refresh_token) return { ok: false, status: 502, message: `Password sign-in failed: ${body.error_description ?? body.msg ?? token.status}` };
    logEvent('info', 'dev.session_minted', { domain: DEV_SESSION_DOMAIN });
    return { ok: true, accessToken: body.access_token, refreshToken: body.refresh_token, email: clean };
  } catch (e) {
    return { ok: false, status: 502, message: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}
