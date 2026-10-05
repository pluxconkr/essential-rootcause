/**
 * Keeps the SQL enums in supabase/migrations/0001_init.sql in step with src/domain/types.ts and taxonomy.ts
 * (plan §6: "Enums … a test checks them against the migration") and checks the structural promises the plan makes
 * about the schema: RLS on every table, append-only triggers on the three audit tables, the auth.users trigger,
 * the RPCs and report columns the server contract names (src/server/repos/supabase/*, src/server/ratelimit.ts;
 * plan §6, §12) and the seed's tenant slug and SLA bands (spec O10).
 */
/// <reference types="node" />
import { readFileSync } from 'fs';
import { join } from 'path';

import { PILOT } from '@/domain/pilot';
import { CATEGORIES, STORM_SENSITIVITIES } from '@/domain/taxonomy';
import { INJURY_FLAGS, PHOTO_PHASES, REPORTER_DISPLAYS, REPORT_STATUSES, ROLES } from '@/domain/types';

const root = join(__dirname, '..');
const migration = readFileSync(join(root, 'supabase', 'migrations', '0001_init.sql'), 'utf8');
const seed = readFileSync(join(root, 'supabase', 'seed.sql'), 'utf8');

function enumValues(name: string): string[] {
  const m = migration.match(new RegExp(`^create type ${name} as enum \\(([^)]*)\\);`, 'm'));
  if (!m) throw new Error(`enum ${name} not found in the migration`);
  return (m[1] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

const tables = [...migration.matchAll(/^create table (\w+) \(/gm)].map((m) => m[1] ?? '');

describe('0001_init.sql mirrors the domain contracts', () => {
  test.each([
    ['report_status', REPORT_STATUSES],
    ['category', CATEGORIES],
    ['reporter_display', REPORTER_DISPLAYS],
    ['injury_flag', INJURY_FLAGS],
    ['app_role', ROLES],
    ['photo_phase', PHOTO_PHASES],
    ['storm_sensitivity', STORM_SENSITIVITIES],
  ] as const)('enum %s matches the TypeScript constant', (name, values) => {
    expect(enumValues(name)).toEqual([...values]);
  });

  test('every table from plan §6 exists, plus app_settings for the tick', () => {
    const expected = [
      'app_settings', 'tenant', 'app_user', 'sms_message', 'device', 'on_call', 'report', 'report_photo', 'report_vote',
      'report_comment', 'report_event', 'report_follow', 'verification', 'content_flag', 'severity_audit',
      'vision_feedback', 'watch_area', 'block_group', 'block_group_stats', 'weather_forecast', 'scenario',
      'scenario_run', 'alert', 'alert_delivery', 'rate_limit_counter', 'job_run', 'sla_config', 'remediation_option',
      'audit_log',
    ];
    expect([...tables].sort()).toEqual([...expected].sort());
  });

  test('RLS is enabled on every table and no policy is declared', () => {
    for (const t of tables) expect(migration).toContain(`alter table ${t} enable row level security;`);
    expect(migration).not.toMatch(/create policy/i);
  });

  test('append-only tables reject UPDATE, DELETE and TRUNCATE by trigger', () => {
    for (const t of ['report_event', 'severity_audit', 'audit_log']) {
      expect(migration).toMatch(new RegExp(`before update or delete on ${t}\\s+for each row execute function public.raise_append_only\\(\\)`));
      expect(migration).toMatch(new RegExp(`before truncate on ${t}\\s+for each statement execute function public.raise_append_only\\(\\)`));
    }
  });

  test('auth.users insert creates the app_user row', () => {
    expect(migration).toMatch(/after insert on auth\.users\s+for each row execute function public\.handle_new_auth_user\(\)/);
  });

  test('the RPCs carry the signatures the server calls (src/server/ratelimit.ts, repos/supabase/*)', () => {
    expect(migration).toContain('function public.rate_limit_hit(p_key text, p_limit int, p_window_sec int)');
    // the server passes the first four by name and no tenant (repos/supabase/reports.ts), so p_tenant must stay optional and last
    expect(migration).toContain('function public.find_duplicates(p_lat double precision, p_lng double precision, p_category category, p_radius_m double precision, p_tenant uuid default null)');
    expect(migration).toMatch(
      /function public\.reports_in_bbox\(\s*p_tenant uuid default null,\s*p_min_lng double precision default null,\s*p_min_lat double precision default null,\s*p_max_lng double precision default null,\s*p_max_lat double precision default null,\s*p_category category default null,\s*p_status report_status default null,\s*p_sort text default 'score',\s*p_cursor_id text default null,\s*p_limit int default 50\s*\)/,
    );
    expect(migration).toContain('function public.usage_bytes()');
    expect(migration).toContain('function public.audience_for_hazards(p_tenant uuid, p_hazard_ids uuid[], p_buffer_m double precision)');
  });

  test('find_duplicates uses the memory repo\'s open statuses (everything before completed)', () => {
    expect(migration).toContain("r.status in ('new', 'triaged', 'assessed', 'mitigated', 'scheduled')");
  });

  test('report exposes lat/lng and public_lat/public_lng generated from geom / geom_public (REPORT_COLUMNS)', () => {
    expect(migration).toContain('lat double precision generated always as (st_y(geom::geometry)) stored');
    expect(migration).toContain('lng double precision generated always as (st_x(geom::geometry)) stored');
    expect(migration).toContain('public_lat double precision generated always as (st_y(geom_public::geometry)) stored');
    expect(migration).toContain('public_lng double precision generated always as (st_x(geom_public::geometry)) stored');
  });

  test('geometry columns are geography with a GiST index (plan §6)', () => {
    for (const col of ['geom', 'geom_public']) expect(migration).toContain(`create index report_${col}_gix on report using gist (${col});`);
    expect(migration).toContain('create index watch_area_geom_gix on watch_area using gist (geom);');
    expect(migration).toContain('create index block_group_geom_gix on block_group using gist (geom);');
  });
});

describe('seed.sql', () => {
  test('inserts the tenant under PILOT.slug (the API looks it up by slug) with the spec score weights', () => {
    expect(seed).toContain(`'${PILOT.slug}'`);
    expect(seed).toContain('{"severity": 0.32, "exposure": 0.24, "community": 0.22, "liability": 0.14, "decay": 0.08}');
  });

  test('seeds one SLA row per severity band with the plan §8 intervals', () => {
    expect(seed).toContain("(4, interval '15 minutes', interval '2 hours', interval '24 hours', interval '30 days')");
    expect(seed).toContain("(3, interval '1 day', interval '10 days', interval '14 days', interval '90 days')");
    expect(seed).toContain("(2, interval '3 days', interval '30 days', null::interval, interval '120 days')");
    expect(seed).toContain("(1, interval '5 days', interval '90 days', null::interval, interval '365 days')");
  });

  test('seeds the six remediation options and the tick placeholders', () => {
    for (const cost of [420, 3900, 5200, 7800, 9400, 2600]) expect(seed).toMatch(new RegExp(`, ${cost}, `));
    expect(seed).toContain("('job_url', 'unset')");
    expect(seed).toContain("('job_secret', 'unset')");
    expect(seed).toContain("cron.schedule(\n  'rootcause-jobs-tick',\n  '* * * * *'");
  });
});

describe('0001_init.sql keeps every RPC away from anon/authenticated (security review 2026-10-05)', () => {
  const functionDefs = [...migration.matchAll(/^create or replace function public\.(\w+)\(/gm)].map((m) => ({ name: m[1] ?? '', index: m.index ?? 0 }));
  const blanket = migration.indexOf('revoke all on all functions in schema public from public, anon, authenticated');

  test('the blanket revoke exists and runs after the last function definition', () => {
    expect(blanket).toBeGreaterThan(0);
    for (const f of functionDefs) expect(f.index).toBeLessThan(blanket);
    expect(migration).toContain('grant execute on all functions in schema public to service_role');
    expect(migration).toContain('alter default privileges for role postgres in schema public revoke all on functions from public, anon, authenticated');
  });

  test('every function also has an explicit per-signature revoke from public, anon, authenticated', () => {
    for (const f of functionDefs) {
      const re = new RegExp(`^revoke execute on function public\\.${f.name}\\([^)]*\\) from public, anon, authenticated;`, 'm');
      expect({ fn: f.name, revoked: re.test(migration) }).toEqual({ fn: f.name, revoked: true });
    }
  });

  test('nothing is ever granted to anon or authenticated', () => {
    expect(migration).not.toMatch(/^grant [^;]* to (anon|authenticated)\b/m);
    expect(migration).not.toMatch(/create policy/i);
  });

  test('every security definer function has a fixed search_path', () => {
    const defs = [...migration.matchAll(/create or replace function public\.(\w+)\([\s\S]*?\$\$/g)];
    for (const d of defs) {
      if (!/security definer/.test(d[0])) continue;
      expect({ fn: d[1], searchPath: /set search_path = /.test(d[0]) }).toEqual({ fn: d[1], searchPath: true });
    }
  });
});
