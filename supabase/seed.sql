/**
 * Seed — the pilot tenant (plan §6 tenant), the SLA matrix (spec O10 / plan §6, §8), the root-conflict remediation
 * ladder (spec remediation_option dev note), the operator settings the database reads, and the pg_cron tick that
 * POSTs /api/jobs/tick every minute through pg_net (plan §11).
 * Idempotent: every insert is `on conflict do nothing` and the cron job is replaced by name, so it can be re-run.
 * `supabase db reset` applies it locally; preview and production get it once by hand (docs/runbook.md), because
 * `supabase db push` does not run seeds.
 */

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Pilot tenant — fixed id so scripts and tests can reference it. The slug must equal PILOT.slug
--    (src/domain/pilot.ts, i.e. EXPO_PUBLIC_PILOT, default new-brunswick-nj): the API resolves the tenant by it.
-- ---------------------------------------------------------------------------------------------------------------
insert into tenant (id, slug, name, score_weights, community_k, active_users_floor, storm_multiplier_max, injury_notify_emails, vision_daily_max, sms_enabled)
values (
  '00000000-0000-4000-8000-000000000001',
  'new-brunswick-nj',
  'New Brunswick, NJ (pilot)',
  -- spec §7 score weights (plan §8 score.ts WEIGHTS)
  '{"severity": 0.32, "exposure": 0.24, "community": 0.22, "liability": 0.14, "decay": 0.08}'::jsonb,
  -- plan §8 communityTerm k
  0.25,
  -- plan §8 active users floor
  20,
  -- spec §7 storm multiplier ceiling
  1.6,
  '{}',
  -- plan §3.6 vision daily breaker
  500,
  -- SMS stays off until the Messaging Service and 10DLC registration are live (plan §3.12)
  false
)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. SLA matrix — spec O10 rows; plan §6 numeric values for the prose cells (Next cycle = 90 d, 1 season = 120 d,
--    Bundled = 365 d) and plan §8 "Same day" = 24 h. severity_band 4 = emergency, 3 = high, 2 = moderate, 1 = low.
-- ---------------------------------------------------------------------------------------------------------------
insert into sla_config (tenant_id, severity_band, ack, assess, mitigate, fix)
select t.id, v.band, v.ack, v.assess, v.mitigate, v.fix
from tenant t
cross join (
  values
    (4, interval '15 minutes', interval '2 hours', interval '24 hours', interval '30 days'),
    (3, interval '1 day', interval '10 days', interval '14 days', interval '90 days'),
    (2, interval '3 days', interval '30 days', null::interval, interval '120 days'),
    (1, interval '5 days', interval '90 days', null::interval, interval '365 days')
) as v (band, ack, assess, mitigate, fix)
where t.slug = 'new-brunswick-nj'
on conflict (tenant_id, severity_band) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Root-conflict remediation ladder (spec "Root-conflict remediation ladder" table, lines ~1740–1757).
--    Applies to root_heave orders, whose taxonomy category is vegetation (src/domain/taxonomy.ts).
--    expected_recurrence_months = lower bound of the spec range; recurrence_label keeps the spec wording.
-- ---------------------------------------------------------------------------------------------------------------
insert into remediation_option (category, name, unit_cost, expected_recurrence_months, recurrence_label, tree_outcome, sort_order)
values
  ('vegetation', 'Asphalt wedge / grind', 420, 8, '8–14 months', 'Neutral', 1),
  ('vegetation', 'Panel replacement, same grade', 3900, 36, '3–5 years', 'Root cutting — may destabilise', 2),
  ('vegetation', 'Flexible / rubber paver section', 5200, 96, '8–12 years', 'Good', 3),
  ('vegetation', 'Sidewalk meander around trunk', 7800, 180, '15+ years', 'Best — no root loss', 4),
  ('vegetation', 'Root bridge + structural soil', 9400, 240, '20+ years', 'Best', 5),
  ('vegetation', 'Removal + replant low-conflict species', 2600, 240, '20+ years', 'Loses 40yr canopy — last resort', 6)
on conflict (category, name) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Operator settings read by the tick. Placeholders: the tick does nothing until job_url starts with "http".
--    Local dev server from inside the Postgres container: http://host.docker.internal:8081/api/jobs/tick.
-- ---------------------------------------------------------------------------------------------------------------
insert into app_settings (key, value)
values
  ('job_url', 'unset'),
  ('job_secret', 'unset')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. pg_cron: every minute, POST /api/jobs/tick with the x-job-secret header (plan §11). The pg_net timeout is
--    explicit: 25 s, and the tick itself returns within 20 s (plan §23.G, §23.H).
--    Runs as the scheduling role in the postgres database; replaced by name so re-seeding never duplicates it.
-- ---------------------------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'rootcause-jobs-tick') then
    perform cron.unschedule('rootcause-jobs-tick');
  end if;
end
$$;

select cron.schedule(
  'rootcause-jobs-tick',
  '* * * * *',
  $job$
    select net.http_post(
      url := s.job_url,
      body := '{}'::jsonb,
      headers := jsonb_build_object('content-type', 'application/json', 'x-job-secret', s.job_secret),
      timeout_milliseconds := 25000
    )
    from (
      select
        (select value from public.app_settings where key = 'job_url') as job_url,
        (select value from public.app_settings where key = 'job_secret') as job_secret
    ) as s
    where s.job_url like 'http%'
  $job$
);
