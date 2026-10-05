/**
 * Grant a staff role to an existing account (the first director is created this way; later grants go through
 * Admin › Users in the console). Server-side only: needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
 * environment. Every grant is written to audit_log.
 *
 *   npx tsx scripts/grant-role.ts someone@city.gov director
 */
import { createClient } from '@supabase/supabase-js';

import { ROLES, type Role } from '../src/domain/types';

async function main() {
  const [email, roleArg] = process.argv.slice(2);
  if (!email || !roleArg || !ROLES.includes(roleArg as Role)) {
    console.error(`usage: grant-role.ts <email> <${ROLES.join('|')}>`);
    process.exit(2);
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server env only).');
    process.exit(2);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data: users, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) throw listErr;
  const user = users.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!user) {
    console.error(`No account with email ${email}. The person must sign in once first.`);
    process.exit(1);
  }
  const { error: updErr } = await supabase.from('app_user').update({ role: roleArg }).eq('id', user.id);
  if (updErr) throw updErr;
  const { error: auditErr } = await supabase.from('audit_log').insert({ actor_id: null, action: 'grant_role', target: user.id, diff: { role: roleArg, via: 'scripts/grant-role.ts' } });
  if (auditErr) throw auditErr;
  console.log(`${email} is now ${roleArg}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
