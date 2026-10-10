/**
 * Apply supabase/migrations/*.sql (and supabase/seed.sql) to the live Supabase project from this machine, without
 * psql or a logged-in Supabase CLI session: the CLI runs from npx and connects with the database URL. Needed once
 * per project before anything live works — the API answers 404 PGRST205 ("Could not find the table") until then.
 *
 *   1. Supabase dashboard → Project Settings → Database → Connection string (URI, "Direct" or "Session pooler"),
 *      paste it into .env as SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@…:5432/postgres
 *   2. npm run db:push            (migrations + seed; re-runnable — the seed is idempotent)
 *      npm run db:push -- --dry   (show what would run)
 *
 * The URL carries the database password: it stays in .env (gitignored) and is never printed here.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function loadDotenv(path: string): void {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotenv(join(process.cwd(), '.env'));
const url = (process.env.SUPABASE_DB_URL ?? '').trim();
if (!url.startsWith('postgres')) {
  console.error('SUPABASE_DB_URL is not set in .env. Copy the connection string (URI) from Supabase → Project Settings → Database and add it as SUPABASE_DB_URL=… (the password stays local).');
  process.exit(2);
}
const dry = process.argv.includes('--dry');
const args = ['--yes', 'supabase@latest', 'db', 'push', '--db-url', url, '--include-seed', ...(dry ? ['--dry-run'] : [])];
console.log(`npx supabase db push --db-url <SUPABASE_DB_URL> --include-seed${dry ? ' --dry-run' : ''}`);
const run = spawnSync('npx', args, { stdio: 'inherit', env: { ...process.env, SUPABASE_DB_URL: '' } });
if (run.status !== 0) {
  console.error('\nThe push did not complete. If the CLI complains about the seed flag, run it without --include-seed and paste supabase/seed.sql into the dashboard SQL editor once.');
  process.exit(run.status ?? 1);
}
console.log('\nSchema applied. Check: GET /api/health on the dev server should report db ok.');
