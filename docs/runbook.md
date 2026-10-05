# RootCause runbook

Operations procedures for the database and the hosted services (plan §22 "Runbook", §3.2 Free-plan consequences, §12 secrets). Every procedure below is something the on-call engineer does by hand; the app has no admin button for any of it. Commands assume the repo root and the Supabase CLI ≥ 2.x. Values in angle brackets are filled per environment; `<db-url>` is always the **Supavisor session-pooler URL** (IPv4; the direct database host is IPv6-only on Free, plan §22).

Environments (plan §22): `development` = local `supabase start`; `preview` and `production` = two Supabase Free projects, two EAS environments, two Twilio Messaging Services, different keys everywhere.

## 1. Local setup

```sh
supabase start                     # Postgres 17 + PostGIS, Auth, Storage, Studio (http://127.0.0.1:54323), Inbucket (54324)
supabase db reset                  # drops and recreates the local DB: supabase/migrations/*.sql, then supabase/seed.sql
supabase status                    # prints the local API URL, anon key and service role key for .env
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
```

After a reset, prove the extensions the plan depends on are live:

```sql
select extname from pg_extension where extname in ('postgis', 'pg_cron', 'pg_net');   -- three rows
select jobname, schedule, active from cron.job;                                       -- rootcause-jobs-tick, * * * * *
```

The tick does nothing until `app_settings.job_url` starts with `http`. To exercise `/api/jobs/tick` locally against `npx expo start --web` (port 8081), the Postgres container reaches the host as `host.docker.internal`:

```sql
update app_settings set value = 'http://host.docker.internal:8081/api/jobs/tick' where key = 'job_url';
update app_settings set value = '<JOB_SECRET from .env>' where key = 'job_secret';
select status_code, content::text from net._http_response order by id desc limit 5;   -- responses of the last ticks
```

Set it back to `unset` when done, or the container posts every minute while the dev server is down (harmless, noisy).

Checks the integration suite runs against this database (plan §14): migrations apply cleanly, `update report_event …` raises `append_only`, anon reads are denied, `rate_limit_hit` counts under concurrency, an insert into `auth.users` creates the `app_user` row.

## 2. Applying migrations to preview and production

`supabase/migrations` is the only schema source. No ad-hoc SQL in production (plan §22).

1. Write the change as a new file `supabase/migrations/<timestamp>_<name>.sql`; never edit an applied file.
2. **Expand → migrate → contract.** A live native build keeps reading the old columns for weeks (store review, slow updaters). So: a migration may add columns, tables, indexes and functions (expand); the next app release reads the new shape and the API backfills (migrate); only a later migration, after the old build is gone from the store, drops or renames (contract). Never rename or drop a column that a live app version still reads. Enum values are append-only for the same reason.
3. `supabase db reset` locally, run `npm test` and `npm run test:int`, and commit.
4. Preview: `supabase link --project-ref <preview-ref>` then `supabase db push`. Smoke `GET /api/health` on the preview deployment.
5. Production, after review: `supabase link --project-ref <prod-ref>` then `supabase db push`. The CI job never pushes to production.
6. `supabase db push` does not run `seed.sql`. On a **new** project apply it once by hand, then set the tick settings:

```sh
psql '<db-url>' -f supabase/seed.sql
psql '<db-url>' -c "update app_settings set value = 'https://<eas-host>/api/jobs/tick' where key = 'job_url';"
psql '<db-url>' -c "update app_settings set value = '<JOB_SECRET>' where key = 'job_secret';"
```

Re-running `seed.sql` is safe (every insert is `on conflict do nothing`; the cron job is replaced by name) and never overwrites a tenant setting the director changed.

## 3. Un-pausing a Free project

Free projects pause after 7 days without API activity (plan §3.2). The uptime monitor on `/api/health` (every 5 minutes, both environments) performs a DB query precisely to prevent this, so a paused project means the monitor was also down — check it afterwards.

1. Dashboard → project → "Restore project" (takes a few minutes; data is intact).
2. Confirm: `GET https://<eas-host>/api/health` returns 200 with `db: ok`.
3. Check the tick is running: `select * from cron.job_run_details order by start_time desc limit 5;` — pg_cron does not catch up on missed minutes; `jobs/tick` resumes from the cursor in `job_run`.
4. Re-enable or fix the uptime check; the missed window shows up in `/api/health` as stale `jobs.*.last_ok_at`.

## 4. Rotating keys

All server secrets live in EAS environment variables (`eas env:set --environment <env> --name <NAME> --value <value> --visibility sensitive`) followed by a redeploy (`eas deploy --environment <env>` for the web/API bundle). Client values (`EXPO_PUBLIC_*`) are inlined at build time — rotating one means a new native build. Rotate in this order so nothing is down longer than a deploy:

| Key | Where it lives | Rotate |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | EAS env (server) | Dashboard → Settings → API → generate new JWT secret or new key → `eas env:set` → redeploy → revoke the old key. Rotating the JWT secret also invalidates every user session (they sign in again; drafts survive). |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | app build | Same dashboard action; requires a native build + web redeploy. |
| `JOB_SECRET` | EAS env + `app_settings.job_secret` | `eas env:set` → redeploy → `update app_settings set value = '<new>' where key = 'job_secret';`. The tick 401s for the minute in between; nothing is lost. |
| `ANTHROPIC_API_KEY` | EAS env | New key in the Anthropic console → `eas env:set` → redeploy → delete the old key. |
| `TWILIO_AUTH_TOKEN` | EAS env | Twilio console → "Request secondary token" → `eas env:set` → redeploy → promote secondary, delete primary. The webhook signature check uses the same token, so redeploy before promoting. |
| `RESEND_API_KEY` | EAS env | New key → `eas env:set` → redeploy → revoke. |
| `OPEN311_API_KEYS` | EAS env | Comma-separated list: add the new key, redeploy, tell the partner, remove the old one later. |

After any rotation: `GET /api/health` 200, one `select 1` through the service role from the deployed routes, one Twilio test message in preview.

## 5. Disabling vision

Two switches, fastest first:

- **Without a deploy (seconds):** `update tenant set vision_daily_max = 0 where slug = 'pilot';` — the route treats the tenant daily max as the breaker (plan §3.6) and S-05 falls back to the manual category picker; the resident flow is otherwise identical (screens test). Restore with `500`.
- **With a deploy:** `eas env:set --name VISION_ENABLED --value false` and redeploy. Use this when the Anthropic key itself must be pulled.

Spend check: count today's analyses with `select count(*) from report_photo where ai_json is not null and created_at > date_trunc('day', now());`. The breaker trips automatically at `vision_daily_max` (≈ $2.50/day at Haiku 4.5 rates).

## 6. Pausing SMS and alerts

- **SMS only:** `update tenant set sms_enabled = false where slug = 'pilot';` (immediate; the channel policy drops `sms`, push/email/inbox continue). Belt and braces: `eas env:set --name SMS_ENABLED --value false` + redeploy. Twilio side: pause the Messaging Service in the console if traffic must stop even for in-flight jobs.
- **Scheduled alerts:** `update alert set scheduled_for = null where sent_at is null;` un-schedules everything pending; the composer shows them as drafts again. Status-change pushes on reports are not alerts and keep flowing.
- **Every job:** `update app_settings set value = 'unset' where key = 'job_url';` stops the tick (no POSTs while `job_url` does not start with `http`); `select cron.unschedule('rootcause-jobs-tick');` removes it entirely (re-run `seed.sql` to restore). Emergency paging also stops — tell the on-call supervisor before doing this.
- Confirm with `/api/health` (`jobs.*.last_ok_at` goes stale) and `select * from alert_delivery where status = 'queued';`.

## 7. Restoring from backup

On the Free plan the nightly `pg_dump` + Storage sync from `.github/workflows/backup.yml` is the only backup (plan §22). Dumps are written through the pooler URL to the encrypted external bucket (object lock, 35-day retention). Placeholder commands until the workflow lands in M3; adjust bucket and names then.

```sh
# 1. Pick the dump
aws s3 ls s3://<backup-bucket>/rootcause/<env>/ | tail
aws s3 cp s3://<backup-bucket>/rootcause/<env>/<date>.dump ./restore.dump

# 2. Restore the database (fresh project or an emptied one; roles and extensions already exist on Supabase)
pg_restore --dbname '<db-url>' --no-owner --no-privileges --clean --if-exists ./restore.dump

# 3. Restore photos
rclone sync <backup-remote>:<backup-bucket>/rootcause/<env>/storage/photos <supabase-s3-remote>:photos

# 4. Re-point the tick and re-check RLS/grants (pg_restore --no-privileges keeps the migration's grants; verify)
psql '<db-url>' -c "select key, value from app_settings;"
psql '<db-url>' -c "select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity;"   -- must be empty
```

Drills: dry run in M0 (recorded below), full restore drill in M3 and before release. Record date, dump size, wall-clock time and anything that surprised you:

| Date | Env | Dump size | Restore time | Notes |
|---|---|---|---|---|
| — | — | — | — | M0 dry run not yet recorded |

## 8. Granting the first director

The person signs in once (email code in the app's settings screen or the console) so their `app_user` row exists, then, with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for that environment in the shell:

```sh
npx tsx scripts/grant-role.ts <person@city.gov> director
```

The script writes `audit_log` itself. Equivalent by hand (when the script is unavailable):

```sql
update app_user
set role = 'director'
where id = (select id from auth.users where email = '<person@city.gov>');

insert into audit_log (actor_id, action, target, diff)
values (null, 'role.grant', '<person@city.gov>', '{"from": "resident", "to": "director", "by": "runbook §8"}');
```

Later grants happen in Admin › Users (plan §3.4), which writes `audit_log` itself. Roles: `resident | steward | inspector | supervisor | director | auditor` (`src/domain/roles.ts`); `auditor` is read-only everywhere.

## 9. Switching the map style URL

The map provider is configuration (plan §3.3): `EXPO_PUBLIC_MAP_STYLE_URL`, default `https://tiles.openfreemap.org/styles/liberty`. OpenFreeMap has no SLA; the fallback is our own `style.json` over a Protomaps PMTiles extract of the pilot area on Cloudflare R2.

1. Build/refresh the extract: `pmtiles extract <planet-or-region>.pmtiles pilot.pmtiles --bbox=<minLng,minLat,maxLng,maxLat>`; upload `pilot.pmtiles` and `style.json` (sources → `pmtiles://https://<r2-host>/pilot.pmtiles`) to R2 with CORS enabled.
2. `eas env:set --environment <env> --name EXPO_PUBLIC_MAP_STYLE_URL --value https://<r2-host>/style.json`.
3. Web console/API: `eas deploy --environment <env>` (takes effect immediately). Native app: the value is inlined at build time, so ship a new build (`eas build --profile <env>`); until it is installed, phones keep using the old URL and the offline pack.
4. Attribution stays visible either way ("© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors" or "© Protomaps © OpenStreetMap contributors"); `src/ui/HazardMap*.tsx` is the only place that knows the provider.

## 10. 10DLC status

US A2P 10DLC brand + campaign registration (or toll-free verification) started in M0; until approval Twilio may filter traffic, so SMS is best-effort with push/email alongside and `tenant.sms_enabled` stays `false` in production (plan §3.12).

| Item | Value / status | Date |
|---|---|---|
| Twilio account SID (production) | — | — |
| Messaging Service SID (preview / production) | — / — | — |
| +1 number | — | — |
| Brand registration | not submitted / pending / approved | — |
| Campaign registration (use case: public-safety notifications, opt-in via S-11 phone verification) | not submitted / pending / approved | — |
| Toll-free verification (alternative) | — | — |
| Opt-in language on file | "Reply STOP to opt out" in every first SMS; verification code copy | — |
| First filtered-traffic check (Twilio logs, error 30034) | — | — |

Update this table at every status change; `tenant.sms_enabled = true` only after "approved".

## 11. R1 spike results (to be filled)

R1 = the EAS Hosting (workerd) spike from plan §3.1: multipart photo upload + a PostGIS query from an Expo API route, plus the pg_cron/pg_net availability check on Free. Fill in the measured facts; the fallback if any row fails is the `@expo/server` Node adapter on Fly.io/Railway.

| Check | Result | Measured | Date |
|---|---|---|---|
| `POST /api/v1/photos` multipart ≤ 600 KB on EAS Hosting | — | p50 / p95 ms | — |
| `GET /api/v1/reports?bbox` → `reports_in_bbox` RPC on EAS Hosting | — | p50 / p95 ms | — |
| Request time budget observed on workerd (max request duration, memory) | — | — | — |
| `create extension pg_cron` / `pg_net` on a Free project | — | — | — |
| `cron.schedule` → `net.http_post` → `/api/jobs/tick` round trip, 5 s budget | — | ms | — |
| Backup dry run through the pooler URL (`pg_dump` size, duration) | — | — | — |
| Twilio REST send + status callback from a route | — | — | — |
