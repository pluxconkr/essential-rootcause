/**
 * RootCause schema v1 — plan §6 (data model), §3.10 (DB-backed rate limits), §11 (job tick), §12 (append-only
 * audit tables, RLS, privacy columns). This folder is the only schema source (plan §22): CI applies it to a fresh
 * local database and releases apply it with `supabase db push`. Later changes are new files that keep the previous
 * native build working (expand → migrate → contract; never rename or drop a column a live app version still reads).
 *
 * The SQL enums mirror src/domain/types.ts and src/domain/taxonomy.ts; __tests__/migration-enums.test.ts keeps them
 * in step. Smaller value sets that plan §6 writes as "enum" but that are not in the enum list (address_confidence,
 * verification.verdict, watch_area.kind, scenario_run.status, device.platform, report_event.actor_type) are
 * text + CHECK so they can be widened without a type change.
 *
 * Access model: every table has RLS on with no policies, and the anon/authenticated roles lose their default grants
 * on public tables and functions — only the service role (used by the Expo API routes) and the owner can touch
 * data. There is no client-direct table access (plan §6).
 */

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Extensions (plan §3.2 — PostGIS is "not optional"; pg_cron + pg_net drive /api/jobs/tick, verified on Free in M0)
-- ---------------------------------------------------------------------------------------------------------------
create schema if not exists extensions;
create extension if not exists postgis with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Enums (mirror src/domain/types.ts: REPORT_STATUSES, REPORTER_DISPLAYS, INJURY_FLAGS, ROLES, PHOTO_PHASES;
--    src/domain/taxonomy.ts: CATEGORIES, STORM_SENSITIVITIES)
-- ---------------------------------------------------------------------------------------------------------------
create type report_status as enum ('new', 'triaged', 'assessed', 'mitigated', 'scheduled', 'completed', 'verified', 'rejected');
create type category as enum ('vegetation', 'roadway', 'sidewalk', 'drainage', 'lighting');
create type reporter_display as enum ('named', 'initials', 'anonymous');
create type injury_flag as enum ('no', 'near_miss', 'injury');
create type app_role as enum ('resident', 'steward', 'inspector', 'supervisor', 'director', 'auditor');
create type photo_phase as enum ('before', 'after');
create type photo_visibility as enum ('staff_only', 'public');
create type storm_sensitivity as enum ('rain', 'wind', 'freeze');
create type alert_severity as enum ('advisory', 'warning', 'emergency');
create type alert_channel as enum ('push', 'sms', 'email', 'inbox');
create type delivery_status as enum ('queued', 'sent', 'delivered', 'failed', 'undelivered');
create type flag_target as enum ('report', 'comment', 'photo');
create type flag_status as enum ('open', 'actioned', 'dismissed');
create type auth_provider as enum ('apple', 'google', 'email');

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Tenant, settings, people (plan §6 tenant / app_user / phone_otp / device / on_call)
-- ---------------------------------------------------------------------------------------------------------------

-- Operator settings read by the database itself (the pg_cron tick in seed.sql reads job_url + job_secret).
create table app_settings (
  key text primary key,
  value text
);

create table tenant (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  -- spec §7 / plan §8 score.ts WEIGHTS: severity .32, exposure .24, community .22, liability .14, decay .08
  score_weights jsonb not null default '{"severity": 0.32, "exposure": 0.24, "community": 0.22, "liability": 0.14, "decay": 0.08}'::jsonb,
  -- plan §8 communityTerm: k = 0.25, N = max(activeUsers, floor 20)
  community_k numeric not null default 0.25,
  active_users_floor int not null default 20,
  -- spec §7: storm_multiplier 1.0 – 1.6 when a matching scenario is active
  storm_multiplier_max numeric not null default 1.6,
  injury_notify_emails text[] not null default '{}',
  -- plan §3.6: VISION_DAILY_MAX default 500/day trips the vision flag off for the day
  vision_daily_max int not null default 500,
  sms_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table block_group (
  geoid text primary key,
  tenant_id uuid not null references tenant (id),
  ward_id text,
  -- Census TIGER shapes (MultiPolygon); loaded by scripts/build-census.ts
  geom geography not null,
  population int,
  median_hh_income numeric
);
create index block_group_geom_gix on block_group using gist (geom);
create index block_group_tenant_idx on block_group (tenant_id, ward_id);

create table app_user (
  -- id = auth.uid(); the row is created by the auth.users trigger below and removed with the auth user (DELETE /me)
  id uuid primary key references auth.users (id) on delete cascade,
  tenant_id uuid not null references tenant (id),
  role app_role not null default 'resident',
  display_name text,
  auth_provider auth_provider not null default 'email',
  home_geom geography(Point, 4326),
  -- derived by spatial join; no FK so a Census reload does not cascade through users and reports
  block_group_id text,
  verified_resident boolean not null default false,
  trust_score numeric not null default 1.0,
  phone_e164 text,
  phone_verified_at timestamptz,
  sms_opt_in boolean not null default false,
  quiet_hours jsonb,
  blocked_by uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
comment on column app_user.home_geom is 'Never leaves the server (plan §6, §12).';
comment on column app_user.phone_e164 is 'E.164; never exposed through any projection (plan §12).';
create index app_user_staff_idx on app_user (tenant_id, role) where role <> 'resident';

-- plan §3.12: hashed 6-digit code, 10-minute expiry, 5 attempts, 3 sends/hour (limits enforced by the route)
create table phone_otp (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user (id) on delete cascade,
  -- the number the code was sent to, so verify stores exactly what was proven
  phone_e164 text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);
create index phone_otp_user_idx on phone_otp (user_id, created_at desc);

create table device (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user (id) on delete cascade,
  -- one row per token; a sign-in on a shared phone moves the token to the new user (upsert on the token)
  expo_push_token text not null unique,
  platform text not null check (platform in ('ios', 'android', 'web')),
  install_id text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index device_user_idx on device (user_id);

-- Rota for emergency paging (plan §11 escalation job)
create table on_call (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  user_id uuid not null references app_user (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  order_no int not null default 0,
  check (ends_at > starts_at)
);
create index on_call_window_idx on on_call (tenant_id, starts_at, ends_at);

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Reports and everything hanging off them (plan §6 report … vision_feedback)
-- ---------------------------------------------------------------------------------------------------------------
create table report (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  -- idempotency key from the phone (src/domain/ids.ts); a replay returns the original report (plan §7)
  client_draft_id text not null unique,
  -- NULL for anonymous reports (plan §3.4 unlinkability) and after DELETE /me de-identification (plan §12)
  reporter_id uuid references app_user (id) on delete set null,
  reporter_display reporter_display not null default 'anonymous',
  category category not null,
  -- taxonomy sub-type id (src/domain/taxonomy.ts SUBTYPES); validated by zod, kept text so the taxonomy can grow
  subtype text not null,
  status report_status not null default 'new',
  severity_resident smallint check (severity_resident between 1 and 4),
  severity_ai smallint check (severity_ai between 1 and 4),
  severity_confirmed smallint check (severity_confirmed between 1 and 4),
  emergency_requested boolean not null default false,
  emergency_ack_at timestamptz,
  emergency_ack_by uuid references app_user (id) on delete set null,
  injury_flag injury_flag not null default 'no',
  ada_flag boolean not null default false,
  storm_sensitivity storm_sensitivity[] not null default '{}',
  -- precise location; staff only. coarsenGps snaps it to 50 m for anonymous reports after day 30 (plan §11, §12)
  geom geography(Point, 4326) not null,
  -- what the public map and feed see (src/domain/geo.ts publicPoint, computed at insert)
  geom_public geography(Point, 4326) not null,
  gps_accuracy_m numeric,
  address_text text,
  address_confidence text not null default 'approx' check (address_confidence in ('exact', 'approx')),
  ward_id text,
  block_group_id text,
  -- the resident's free-text note (CreateReportInput.note); shown to staff, never in the public projection
  note text,
  exposure_terms jsonb not null default '{}'::jsonb,
  score numeric not null default 0,
  score_terms jsonb not null default '{}'::jsonb,
  -- 1.0 unless an approved scenario_run covers this report (plan §3.7)
  storm_multiplier numeric not null default 1.0,
  vote_count int not null default 0,
  -- anonymous reports keep the reporter's own vote here instead of a report_vote row (plan §3.4, D13)
  reporter_vote_weight numeric not null default 0,
  cluster_id uuid references report (id) on delete set null,
  cluster_candidate uuid references report (id) on delete set null,
  -- vendor / Open311 identifier (plan §3.11 WorkOrderSync seam)
  external_id text,
  -- {"supervisor_review": bool, "council_item": bool, "suspicious": bool}
  flags jsonb not null default '{}'::jsonb,
  captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  first_ack_at timestamptz,
  assessed_at timestamptz,
  mitigated_at timestamptz,
  scheduled_for timestamptz,
  completed_at timestamptz,
  verified_at timestamptz,
  closed_at timestamptz
);
comment on column report.geom is 'Precise location; staff only. The public projection uses geom_public (plan §12).';

-- plan §6 index list (spec §6 indexing notes)
create index report_geom_gix on report using gist (geom);
create index report_geom_public_gix on report using gist (geom_public);
create index report_queue_idx on report (tenant_id, status, score desc);
create index report_emergency_idx on report (tenant_id, created_at desc) where emergency_requested;
create index report_open_idx on report (tenant_id, created_at desc) where status in ('new', 'triaged');
create index report_created_brin on report using brin (created_at);
-- "My reports", merge, Open311 lookups
create index report_reporter_idx on report (reporter_id, created_at desc) where reporter_id is not null;
create index report_cluster_idx on report (cluster_id) where cluster_id is not null;
create index report_external_idx on report (tenant_id, external_id) where external_id is not null;

create table report_photo (
  id uuid primary key default gen_random_uuid(),
  -- NULL while pending (uploaded, not yet attached); purgePhotos deletes unattached rows after 24 h (plan §11)
  report_id uuid references report (id) on delete cascade,
  -- always NULL once attached to an anonymous report (plan §3.4)
  uploader_id uuid references app_user (id) on delete set null,
  -- private bucket keys; EXIF stripped on device and server (plan §12)
  storage_key text not null,
  thumb_key text not null,
  phase photo_phase not null default 'before',
  width int,
  height int,
  bytes int,
  captured_at timestamptz,
  -- false in v1 (no on-device blur); column ready for Phase 2
  faces_blurred boolean not null default false,
  -- staff_only until an inspector releases the photo at triage (plan §12)
  visibility photo_visibility not null default 'staff_only',
  -- raw vision output kept for audit (spec §6)
  ai_json jsonb,
  model_version text,
  created_at timestamptz not null default now()
);
create index report_photo_report_idx on report_photo (report_id, created_at);
create index report_photo_pending_idx on report_photo (created_at) where report_id is null;

create table report_vote (
  report_id uuid not null references report (id) on delete cascade,
  user_id uuid not null references app_user (id) on delete cascade,
  -- plan §8 votes.ts: 0.6 new account / 1.0, halved while flagged suspicious
  weight numeric not null default 1.0,
  block_group_id text,
  unverified_geo boolean not null default false,
  install_id text,
  created_at timestamptz not null default now(),
  primary key (report_id, user_id)
);
create index report_vote_user_idx on report_vote (user_id, created_at desc);
-- anomaly flags: velocity per install, same install many accounts (plan §8 votes.ts)
create index report_vote_install_idx on report_vote (install_id, created_at desc) where install_id is not null;

create table report_comment (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references report (id) on delete cascade,
  -- NULL after DELETE /me: shown as "former user" (plan §12)
  user_id uuid references app_user (id) on delete set null,
  body text not null,
  is_staff boolean not null default false,
  -- internal notes are labelled "still subject to records requests" in the UI (plan §6, §12)
  is_internal boolean not null default false,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
comment on column report_comment.is_internal is 'Staff-only note; still subject to public records requests (plan §12).';
create index report_comment_report_idx on report_comment (report_id, created_at);

-- Append-only timeline (plan §6, §12). actor_id has no FK on purpose: the row must outlive the account, and an
-- ON DELETE action would be an UPDATE that the append-only trigger rejects.
create table report_event (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references report (id),
  actor_type text not null check (actor_type in ('resident', 'staff', 'system')),
  actor_id uuid,
  from_status report_status,
  to_status report_status,
  kind text not null,
  note text,
  created_at timestamptz not null default now()
);
create index report_event_report_idx on report_event (report_id, created_at);

create table report_follow (
  report_id uuid not null references report (id) on delete cascade,
  user_id uuid not null references app_user (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (report_id, user_id)
);
create index report_follow_user_idx on report_follow (user_id);

create table verification (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references report (id) on delete cascade,
  user_id uuid references app_user (id) on delete set null,
  verdict text not null check (verdict in ('confirmed', 'rejected')),
  photo_id uuid references report_photo (id) on delete set null,
  created_at timestamptz not null default now()
);
create index verification_report_idx on verification (report_id, created_at);

-- Moderation queue (plan §7 flag routes, §12 abuse)
create table content_flag (
  id uuid primary key default gen_random_uuid(),
  target_type flag_target not null,
  target_id uuid not null,
  reporter_id uuid references app_user (id) on delete set null,
  reason text,
  status flag_status not null default 'open',
  created_at timestamptz not null default now()
);
create index content_flag_open_idx on content_flag (created_at) where status = 'open';
create index content_flag_target_idx on content_flag (target_type, target_id);

-- Append-only (plan §12); inspector_id has no FK for the same reason as report_event.actor_id
create table severity_audit (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references report (id),
  ai_value smallint,
  human_value smallint not null,
  inspector_id uuid,
  reason text,
  model_version text,
  created_at timestamptz not null default now()
);
create index severity_audit_report_idx on severity_audit (report_id, created_at);

-- Label store: every resident correction of a vision proposal (plan §3.6)
create table vision_feedback (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references report (id) on delete set null,
  photo_id uuid not null references report_photo (id) on delete cascade,
  proposed jsonb not null,
  corrected jsonb not null,
  user_id uuid references app_user (id) on delete set null,
  model_version text,
  created_at timestamptz not null default now()
);

-- Never exposed to other users (plan §6, §12)
create table watch_area (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user (id) on delete cascade,
  kind text not null check (kind in ('home', 'work', 'route', 'custom')),
  -- Point for home/work/custom, LineString for route; radius_m widens it either way
  geom geography not null,
  radius_m numeric not null default 500,
  -- empty = every category
  categories category[] not null default '{}',
  schedule jsonb,
  created_at timestamptz not null default now()
);
create index watch_area_geom_gix on watch_area using gist (geom);
create index watch_area_user_idx on watch_area (user_id);

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Equity, weather, scenarios, alerts (plan §6 block_group_stats … alert_delivery)
-- ---------------------------------------------------------------------------------------------------------------
create table block_group_stats (
  geoid text not null references block_group (geoid) on delete cascade,
  computed_at timestamptz not null default now(),
  active_users int not null default 0,
  reports_per_1k numeric,
  median_days_to_close numeric,
  -- percentile rank (0–100) of Σ score of open reports per 1k residents (plan §6 definitions)
  open_hazard_index numeric,
  reporting_pct numeric,
  index_pct numeric,
  -- gap = index_pct − reporting_pct (spec O10)
  gap numeric,
  primary key (geoid, computed_at)
);

-- NWS gridpoint forecast rows (plan §11 weatherPoll)
create table weather_forecast (
  id uuid primary key default gen_random_uuid(),
  issued_at timestamptz not null,
  valid_from timestamptz not null,
  valid_to timestamptz not null,
  grid_id text not null,
  rain_mm numeric,
  -- NWS probabilityOfPrecipitation; the "confidence" of rain scenarios (plan §3.7)
  pop_pct numeric,
  gust_kmh numeric,
  temp_min numeric,
  temp_max numeric,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index weather_forecast_latest_idx on weather_forecast (grid_id, issued_at desc);

-- spec §9 shape: trigger_expr JSON rule, action_thresholds per action
create table scenario (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  name text not null,
  kind storm_sensitivity not null,
  trigger_expr jsonb not null,
  action_thresholds jsonb not null default '{}'::jsonb,
  -- spec §7: 1.0 – 1.6; the tenant's storm_multiplier_max caps it in the app
  storm_multiplier numeric not null default 1.0 check (storm_multiplier >= 1.0),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table scenario_run (
  id uuid primary key default gen_random_uuid(),
  scenario_id uuid not null references scenario (id) on delete cascade,
  forecast_id uuid references weather_forecast (id) on delete set null,
  triggered_at timestamptz not null default now(),
  worklist jsonb not null default '[]'::jsonb,
  audience_count int not null default 0,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'dispatched', 'closed')),
  -- post-event outcome (plan §11 postEvent)
  outcome jsonb
);
create index scenario_run_scenario_idx on scenario_run (scenario_id, triggered_at desc);
create index scenario_run_active_idx on scenario_run (status) where status in ('approved', 'dispatched');

-- Content-addressed per spec O11 dev note: audience query, hazard ids and forecast snapshot are stored per send
create table alert (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  scenario_run_id uuid references scenario_run (id) on delete set null,
  severity alert_severity not null,
  channel_mix jsonb not null default '{}'::jsonb,
  audience_query jsonb not null default '{}'::jsonb,
  hazard_ids uuid[] not null default '{}',
  forecast_snapshot jsonb,
  -- English only in v1 (D6) but keeps the spec shape: {"en": {"title": "…", "body": "…"}}
  body_i18n jsonb not null,
  approved_by uuid references app_user (id) on delete set null,
  scheduled_for timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index alert_due_idx on alert (tenant_id, scheduled_for) where sent_at is null;

create table alert_delivery (
  alert_id uuid not null references alert (id) on delete cascade,
  user_id uuid not null references app_user (id) on delete cascade,
  channel alert_channel not null,
  status delivery_status not null default 'queued',
  -- Twilio Message SID / Expo ticket id; the Twilio webhook looks rows up by it
  provider_id text,
  sent_at timestamptz,
  opened_at timestamptz,
  action_taken text,
  error text,
  created_at timestamptz not null default now(),
  primary key (alert_id, user_id, channel)
);
-- fatigue budget = push + sms rows per user per 7 days (plan §6, §11)
create index alert_delivery_fatigue_idx on alert_delivery (user_id, created_at desc) where channel in ('push', 'sms');
create index alert_delivery_provider_idx on alert_delivery (provider_id) where provider_id is not null;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Runtime support: rate limits, jobs, SLA, remediation ladder, audit (plan §3.10, §11, §6)
-- ---------------------------------------------------------------------------------------------------------------

-- Keyed by hashed user id (or IP) + window; holds no report ids (plan §12). Old windows are purged by purgePhotos.
create table rate_limit_counter (
  key text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);

-- One row per job name; drives /api/jobs/tick and /api/health (plan §11)
create table job_run (
  name text primary key,
  started_at timestamptz,
  finished_at timestamptz,
  ok boolean,
  cursor jsonb,
  error text,
  last_ok_at timestamptz
);

-- spec O10 SLA matrix; severity_band 4 = emergency, 3 = high, 2 = moderate, 1 = low (src/domain/types.ts SEVERITY_BANDS)
create table sla_config (
  tenant_id uuid not null references tenant (id) on delete cascade,
  severity_band smallint not null check (severity_band between 1 and 4),
  ack interval not null,
  assess interval not null,
  -- NULL = no mitigation deadline for this band (spec O10 "—")
  mitigate interval,
  fix interval not null,
  primary key (tenant_id, severity_band)
);

-- spec root-conflict remediation ladder; read-only in O3, cities load their own unit costs (spec dev note)
create table remediation_option (
  id uuid primary key default gen_random_uuid(),
  category category not null,
  name text not null,
  unit_cost numeric not null,
  -- lower bound of the spec's recurrence range in months; the label keeps the spec wording ("8–14 months")
  expected_recurrence_months int,
  recurrence_label text,
  tree_outcome text,
  sort_order int not null default 0,
  unique (category, name)
);

-- Staff writes; append-only (plan §12). actor_id has no FK, see report_event.
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  target text,
  diff jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_actor_idx on audit_log (actor_id, created_at desc);
create index audit_log_created_brin on audit_log using brin (created_at);

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Triggers: append-only tables, updated_at, auth.users → app_user (plan §6, §12)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.raise_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'append_only: rows of % cannot be updated or deleted (plan §12)', tg_table_name
    using errcode = 'insufficient_privilege';
end
$$;

create trigger report_event_append_only
  before update or delete on report_event
  for each row execute function public.raise_append_only();
create trigger report_event_no_truncate
  before truncate on report_event
  for each statement execute function public.raise_append_only();

create trigger severity_audit_append_only
  before update or delete on severity_audit
  for each row execute function public.raise_append_only();
create trigger severity_audit_no_truncate
  before truncate on severity_audit
  for each statement execute function public.raise_append_only();

create trigger audit_log_append_only
  before update or delete on audit_log
  for each row execute function public.raise_append_only();
create trigger audit_log_no_truncate
  before truncate on audit_log
  for each statement execute function public.raise_append_only();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger report_touch_updated_at
  before update on report
  for each row execute function public.touch_updated_at();

-- Every auth user gets an app_user row in the pilot tenant as a resident (plan §6). Runs as the function owner
-- because auth inserts happen as supabase_auth_admin, which has no rights on public tables.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
  v_raw_provider text := new.raw_app_meta_data ->> 'provider';
  v_provider auth_provider;
begin
  select t.id into v_tenant
  from public.tenant t
  order by (t.slug = 'pilot') desc, t.created_at
  limit 1;
  if v_tenant is null then
    raise exception 'rootcause: no tenant row — apply supabase/seed.sql before creating users';
  end if;

  v_provider := case
    when v_raw_provider in ('apple', 'google') then v_raw_provider::auth_provider
    else 'email'::auth_provider
  end;

  insert into public.app_user (id, tenant_id, role, display_name, auth_provider)
  values (
    new.id,
    v_tenant,
    'resident',
    nullif(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), ''),
    v_provider
  )
  on conflict (id) do nothing;
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------------------------------------------
-- 8. RPC functions (plan §6 "SQL functions", §3.10)
-- ---------------------------------------------------------------------------------------------------------------

-- Fixed windows aligned to multiples of p_window since the epoch (hourly limits roll over on the hour).
-- Returns true when this hit is beyond p_limit, i.e. hits 1..p_limit are allowed and hit p_limit+1 is refused.
-- The upsert is atomic per (key, window) row, so concurrent requests count correctly (workerd has no memory).
create or replace function public.rate_limit_hit(p_key text, p_limit int, p_window interval)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_s numeric := extract(epoch from p_window);
  v_window_start timestamptz;
  v_count int;
begin
  if v_window_s is null or v_window_s <= 0 then
    raise exception 'rate_limit_hit: p_window must be a positive interval';
  end if;
  v_window_start := to_timestamp((floor(extract(epoch from now()) / v_window_s) * v_window_s)::double precision);

  insert into rate_limit_counter as c (key, window_start, count)
  values (p_key, v_window_start, 1)
  on conflict (key, window_start) do update set count = c.count + 1
  returning c.count into v_count;

  return v_count > p_limit;
end
$$;

-- Open reports (not verified / rejected) of one category within p_radius_m metres, nearest first.
-- p_radius_m comes from src/domain/taxonomy.ts dupRadiusM (25 m point, 60 m linear). Capped at 20 rows.
create or replace function public.find_duplicates(p_tenant uuid, p_lat double precision, p_lng double precision, p_category category, p_radius_m double precision)
returns table (
  id uuid,
  subtype text,
  status report_status,
  score numeric,
  vote_count int,
  address_text text,
  created_at timestamptz,
  distance_m double precision
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    r.id,
    r.subtype,
    r.status,
    r.score,
    r.vote_count,
    r.address_text,
    r.created_at,
    st_distance(r.geom, st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography) as distance_m
  from report r
  where r.tenant_id = p_tenant
    and r.category = p_category
    and r.status not in ('verified', 'rejected')
    and st_dwithin(r.geom, st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography, p_radius_m)
  order by distance_m
  limit 20;
$$;

-- Public map/feed source: uses geom_public only (plan §12), bounding-box overlap on the GiST index, best score
-- first so a truncated page still shows what matters. Optional filters match GET /v1/reports?cat&status;
-- a NULL p_statuses means "open" (not verified / rejected).
create or replace function public.reports_in_bbox(
  p_tenant uuid,
  min_lng double precision,
  min_lat double precision,
  max_lng double precision,
  max_lat double precision,
  p_limit int,
  p_category category default null,
  p_statuses report_status[] default null
)
returns table (
  id uuid,
  category category,
  subtype text,
  status report_status,
  severity_confirmed smallint,
  severity_ai smallint,
  severity_resident smallint,
  emergency_requested boolean,
  score numeric,
  vote_count int,
  lat double precision,
  lng double precision,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    r.id,
    r.category,
    r.subtype,
    r.status,
    r.severity_confirmed,
    r.severity_ai,
    r.severity_resident,
    r.emergency_requested,
    r.score,
    r.vote_count,
    st_y(r.geom_public::geometry) as lat,
    st_x(r.geom_public::geometry) as lng,
    r.created_at
  from report r
  where r.tenant_id = p_tenant
    and r.geom_public && st_makeenvelope(min_lng, min_lat, max_lng, max_lat, 4326)::geography
    and (p_category is null or r.category = p_category)
    and (
      case when p_statuses is null then r.status not in ('verified', 'rejected') else r.status = any (p_statuses) end
    )
  order by r.score desc, r.created_at desc
  limit greatest(p_limit, 0);
$$;

-- spec §9 audience selection: users whose watch area (point/route + radius) touches the hazard buffer and whose
-- category list is empty or contains the hazard's category. Schedule, fatigue and quiet hours are applied in
-- src/domain/audience.ts afterwards (plan §8).
create or replace function public.audience_for_hazards(p_tenant uuid, p_hazard_ids uuid[], p_buffer_m double precision)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select distinct w.user_id
  from report r
  join watch_area w
    on st_dwithin(w.geom, r.geom, p_buffer_m + coalesce(w.radius_m, 0)::double precision)
   and (cardinality(w.categories) = 0 or r.category = any (w.categories))
  join app_user u
    on u.id = w.user_id
   and u.tenant_id = p_tenant
  where r.tenant_id = p_tenant
    and r.id = any (p_hazard_ids);
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 9. Storage: private photo bucket (plan §3.2, §12). Signed URLs are minted server-side; uploads go through the API.
-- ---------------------------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    -- 1 MiB ceiling in Storage; the API enforces the 600 KB upload cap (plan §7)
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('photos', 'photos', false, 1048576, array['image/jpeg'])
    on conflict (id) do nothing;
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 10. RLS on every table, no policies; client roles lose their default grants (plan §6, §12 "service role only")
-- ---------------------------------------------------------------------------------------------------------------
alter table app_settings enable row level security;
alter table tenant enable row level security;
alter table block_group enable row level security;
alter table app_user enable row level security;
alter table phone_otp enable row level security;
alter table device enable row level security;
alter table on_call enable row level security;
alter table report enable row level security;
alter table report_photo enable row level security;
alter table report_vote enable row level security;
alter table report_comment enable row level security;
alter table report_event enable row level security;
alter table report_follow enable row level security;
alter table verification enable row level security;
alter table content_flag enable row level security;
alter table severity_audit enable row level security;
alter table vision_feedback enable row level security;
alter table watch_area enable row level security;
alter table block_group_stats enable row level security;
alter table weather_forecast enable row level security;
alter table scenario enable row level security;
alter table scenario_run enable row level security;
alter table alert enable row level security;
alter table alert_delivery enable row level security;
alter table rate_limit_counter enable row level security;
alter table job_run enable row level security;
alter table sla_config enable row level security;
alter table remediation_option enable row level security;
alter table audit_log enable row level security;

-- Supabase grants anon/authenticated on every new public object by default; take that away here and for future
-- migrations, and keep the service role (the API) and the auth admin (the auth.users trigger) working.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on all tables in schema public from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
    revoke all on all functions in schema public from public, anon, authenticated;
    alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
    alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
    alter default privileges for role postgres in schema public revoke all on functions from public, anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema public to service_role;
    grant all on all tables in schema public to service_role;
    grant all on all sequences in schema public to service_role;
    grant execute on all functions in schema public to service_role;
    alter default privileges for role postgres in schema public grant all on tables to service_role;
    alter default privileges for role postgres in schema public grant all on sequences to service_role;
    alter default privileges for role postgres in schema public grant execute on functions to service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function public.handle_new_auth_user() to supabase_auth_admin;
  end if;
end
$$;
