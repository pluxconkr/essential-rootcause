# RootCause runbook

Operations procedures for the database and the hosted services (plan §22 "Runbook", §3.2 Free-plan consequences, §12 secrets). Every procedure below is something the on-call engineer does by hand; the app has no admin button for any of it. Commands assume the repo root and the Supabase CLI ≥ 2.x. Values in angle brackets are filled per environment; `<db-url>` is always the **Supavisor session-pooler URL** (IPv4; the direct database host is IPv6-only on Free, plan §22).

Environments (plan §22): `development` = local `supabase start`; `preview` and `production` = two Supabase Free projects, two EAS environments, two Twilio Messaging Services, different keys everywhere.

## 0. Running the demo (resident app, 2026-10-10)

What the owner needs before a live demo, in order. Everything below was exercised on 2026-10-10 with the keys in `.env`.

### 0.1 Once per Supabase project

1. **Apply the schema.** The live project has no tables until this runs (the API answers `404 PGRST205 "Could not find the table"`). Supabase dashboard → Project Settings → Database → Connection string (URI, session pooler) → paste into `.env` as `SUPABASE_DB_URL=…` → `npm run db:push` (runs `supabase db push --include-seed` through npx; no CLI login, no psql). Re-runnable.
2. **E-mail codes.** Authentication → Email Templates → *Magic Link*: the body must contain `{{ .Token }}` (the app types the 6-digit code; plan §23.B) — the default template only carries a link. Authentication → URL Configuration → add `rootcause://auth/callback` to the redirect allow-list so the link fallback works. Apple and Google stay off until their credentials exist (`APPLE_*`, `EXPO_PUBLIC_GOOGLE_*` are empty in `.env`; the Google iOS URL-scheme plugin in `app.json` needs the iOS client id).
3. **Jobs.** Set `JOB_SECRET` in `.env` and, after the push, `app_settings.job_url` / `job_secret` (section 2) so pg_cron ticks `/api/jobs/tick` every minute — the weather poll, scenario evaluation and alert dispatch run from that tick.

### 0.2 Two ways to run the API

- **Live (after 0.1):** `npx expo start`. Routes talk to the Supabase project; staff actions use `npx tsx scripts/set-status.ts <reportId> <status> …` (the console stand-in) and the storm demo fires with `npx tsx scripts/demo-storm.ts` (inserts one labelled forecast, evaluates the rain scenario, pushes to every account whose watch area covers a rain-sensitive open report).
- **Dev-memory (no database):** `ROOTCAUSE_DEV_MEMORY=1 ROOTCAUSE_DEV_STAFF=<your sign-in e-mail> npx expo start`. The whole API runs in the dev server's memory with real Supabase Auth sessions; the account named in `ROOTCAUSE_DEV_STAFF` signs in as a supervisor, so the same phone can move a report through the status machine (`PATCH /api/v1/reports/:id`) — `scripts/e2e-check.ts` shows every call. Data lives until the dev server restarts; restart the server after changing server code (routes are not rebundled otherwise). Do not set `CI=1` on a dev server you keep editing against: Expo CLI then runs Metro without file watching, so the phone keeps stale screens until a restart. For a headless launch without a terminal, redirect stdin (`npx expo start … < /dev/null`) instead.
- **Developer sign-in (until SMTP exists):** Supabase's built-in e-mail sends two messages an hour and refuses reserved domains, so the 6-digit code cannot be rehearsed on a simulator. Add `ROOTCAUSE_DEV_SESSION=1` to the dev-memory command and the sign-in sheet of a development build shows "Developer: sign in as a test resident": the dev server mints a throwaway account under `@e2e.rootcause.app` (a real Auth user with a fresh random password each time) and the phone takes its session through the normal `setSession` path. The route is a 404 in every other configuration and never accepts another domain.

The phone finds the API at `EXPO_PUBLIC_API_URL`; left empty, a development build uses the dev server that serves its bundle (`Constants.expoConfig.hostUri`), so laptop and phone must share a network. Port 8081 is taken by the owner's own dev server on this machine — use `--port 8090` for a second one.

### 0.3 The phone

MapLibre needs a development build (Expo Go shows "The map needs a development build…" in place of the map and everything else works). `npx expo run:ios` needs CocoaPods on this Mac (`brew install cocoapods`, not installed on 2026-10-10); `eas build --profile development-simulator` needs `eas login` / `EXPO_ACCESS_TOKEN` (empty). Install the build once online, then the app is cache-first.

### 0.4 Demo walk-through (resident app)

1. Me → Sign in → e-mail code (0.1 step 2). 2. Report tab → photo → live Claude analysis proposes the sub-type with its confidence, exposure (pedestrians/day, road, school route), approximate address and the ADA line → form prefilled → submit → score with five terms and the rank. 3. Home: the report in the ranked queue; vote; Map: the pin, peek card, "Report what I see here". 4. Report detail: comments, follow, share link (`/r/<id>`). 5. Staff move (0.2) → status push lands in Alerts → timeline updates; `completed` with an after-photo → "Is it fixed?" → confirm (two confirmations close it; a rejection with a photo reopens). 6. Offline data → Demo → **Storm**: the Home hero card, the labelled advisory in Alerts, the briefing (why you got it, the spots, what the city is doing); live: `scripts/demo-storm.ts`. 7. Settings: quiet hours, watch areas, phone verification (Twilio Verify; SMS sending stays off until `SMS_ENABLED=true` and 10DLC).

### 0.5 Checks that prove it

`npm run typecheck && npm run lint && npm test` (gate) · `npm run vision:check -- path/to/hazard.jpg` (real model call) · `npx tsx scripts/e2e-check.ts --api http://localhost:8090` (23 steps against a running dev server, two Auth accounts, one vision call).

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
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | app build | Same dashboard action (the legacy anon JWT is accepted in the same argument, plan §23.J); requires a native build + web redeploy. |
| `JOB_SECRET` | EAS env + `app_settings.job_secret` | `eas env:set` → redeploy → `update app_settings set value = '<new>' where key = 'job_secret';`. The tick 401s for the minute in between; nothing is lost. |
| `ANTHROPIC_API_KEY` | EAS env | New key in the Anthropic console → `eas env:set` → redeploy → delete the old key. |
| `TWILIO_AUTH_TOKEN` | EAS env | Twilio console → "Request secondary token" → `eas env:set` → redeploy → promote secondary, delete primary. The webhook signature check uses the same token, so redeploy before promoting. |
| `RESEND_API_KEY` | EAS env | New key → `eas env:set` → redeploy → revoke. |
| `OPEN311_API_KEYS` | EAS env | Comma-separated list: add the new key, redeploy, tell the partner, remove the old one later. |

After any rotation: `GET /api/health` 200, one `select 1` through the service role from the deployed routes, one Twilio test message in preview.

## 5. Disabling vision

Two switches, fastest first:

- **Without a deploy (seconds):** `update tenant set vision_daily_max = 0 where slug = 'new-brunswick-nj';` — the route treats the tenant daily max as the breaker (plan §3.6) and S-05 falls back to the manual category picker; the resident flow is otherwise identical (screens test). Restore with `500`.
- **With a deploy:** `eas env:set --name VISION_ENABLED --value false` and redeploy. Use this when the Anthropic key itself must be pulled.

Spend check: count today's analyses with `select count(*) from report_photo where ai_json is not null and created_at > date_trunc('day', now());`. The breaker trips automatically at `vision_daily_max` (≈ $2.50/day at Haiku 4.5 rates).

## 6. Pausing SMS and alerts

- **SMS only:** `update tenant set sms_enabled = false where slug = 'new-brunswick-nj';` (immediate; the channel policy drops `sms`, push/email/inbox continue). Belt and braces: `eas env:set --name SMS_ENABLED --value false` + redeploy. Twilio side: pause the Messaging Service in the console if traffic must stop even for in-flight jobs.
- **Scheduled alerts:** `update alert set scheduled_for = null where sent_at is null;` un-schedules everything pending; the composer shows them as drafts again. Status-change pushes on reports are not alerts and keep flowing.
- **Every job:** `update app_settings set value = 'unset' where key = 'job_url';` stops the tick (no POSTs while `job_url` does not start with `http`); `select cron.unschedule('rootcause-jobs-tick');` removes it entirely (re-run `seed.sql` to restore). Emergency paging also stops — tell the on-call supervisor before doing this.
- Confirm with `/api/health` (`jobs.*.last_ok_at` goes stale) and `select * from alert_delivery where status = 'queued';`.

## 7. Restoring from backup

On the Free plan the nightly `pg_dump` + Storage sync from `.github/workflows/backup.yml` is the only backup (plan §22). Dumps are written through the pooler URL to the encrypted external bucket (object lock, 35-day retention) as `db/rootcause-<stamp>.dump`, photos under `storage/photos/`; one bucket per environment. Dump policy (plan §23.G): nightly full dump while `pg_database_size() < 100 MB`; above that, weekly full dump + nightly incremental export of the append-only tables and of changed `report`/`report_photo` rows, bytes logged per run — the dump counts against the 5 GB egress. `pg_dump` must match the project's Postgres major (`select version()`); the workflow fails otherwise. The first full drill (M3) may still adjust these commands.

```sh
# 1. Pick the dump
rclone ls <backup-remote>:<backup-bucket>/db/ | tail
rclone copy <backup-remote>:<backup-bucket>/db/rootcause-<stamp>.dump .

# 2. Apply the migrations first (fresh project or an emptied one; roles and extensions already exist on Supabase),
#    then restore. The dump carries no owners or ACLs (pg_dump --no-owner --no-privileges), so every object pg_restore
#    recreates gets the project's default privileges: "service role only" once 0001_init.sql's grants block has run,
#    Supabase's anon/authenticated defaults otherwise.
supabase link --project-ref <ref> && supabase db push
pg_restore --dbname '<db-url>' --no-owner --no-privileges --clean --if-exists ./rootcause-<stamp>.dump

# 3. Restore photos
rclone sync <backup-remote>:<backup-bucket>/storage/photos/ <supabase-s3-remote>:photos

# 4. Re-point the tick and prove RLS and grants
psql '<db-url>' -c "select key, value from app_settings;"
psql '<db-url>' -c "select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity;"   -- must be empty
psql '<db-url>' -c "select table_name, grantee from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated');"   -- must be empty
psql '<db-url>' -c "select routine_name, grantee from information_schema.routine_privileges where specific_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC');"   -- must be empty; otherwise re-run section 10 of 0001_init.sql
```

Open point for the M3 drill: while `auth.users` data loads, the migration's `on_auth_user_created` trigger inserts `app_user` rows that then collide with the dumped `app_user` data. The drill decides between loading data with `set session_replication_role = replica` (Supabase's documented restore path: `psql --command … --file`) and dropping the trigger for the load.

Drills (plan §23.G): dry run in M0 (recorded below); restore drill in M3 into a local `supabase start` pinned to the project's Postgres major (same extensions), and before release into preview after a snapshot. Record date, dump size, wall-clock time and anything that surprised you:

| Date | Env | Dump size | Restore time | Notes |
|---|---|---|---|---|
| — | — | — | — | M0 dry run not yet recorded |

## 8. Granting the first director

The person signs in once (email code in the app's settings screen or the console) so their `app_user` row exists, then, with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for that environment in the shell:

```sh
npx tsx scripts/grant-role.ts <person@city.gov> director
```

The script writes `audit_log` itself. Equivalent by hand (when the script is unavailable), with the script's row shape so audit queries find both:

```sql
update app_user
set role = 'director'
where id = (select id from auth.users where email = '<person@city.gov>');

insert into audit_log (actor_id, action, target, diff)
select null, 'grant_role', id::text, '{"role": "director", "via": "runbook §8"}'
from auth.users where email = '<person@city.gov>';
```

Later grants happen in Admin › Users (plan §3.4), which writes `audit_log` itself. Roles: `resident | steward | inspector | supervisor | director | auditor` (`src/domain/roles.ts`); `auditor` is read-only everywhere.

## 9. Switching the map tiles to the fallback bundle

The app renders a bundled snapshot of the OpenFreeMap `liberty` style (`assets/map/style.json`, refreshed by `scripts/fetch-map-style.ts`; plan §23.F), so the style always loads and report pins render even when every tile request fails. `EXPO_PUBLIC_MAP_STYLE_URL` only selects the remote style the snapshot script and the offline pack use. OpenFreeMap has no SLA; the fallback is our own bundle on Cloudflare R2, and the switch is server-side — no env change, no build.

1. Fallback bundle (built and smoke-tested in M0/M2; rebuild when the pilot bbox changes): Planetiler OpenMapTiles-schema PMTiles of the pilot bbox plus copies of the liberty style, the non-ideograph glyph ranges and the sprites, on R2 with CORS and range requests enabled.
2. Switch: point the active style source that `GET /api/v1/config` serves at the fallback style URL (the setting lands with the route in M2; the bundled value is the default). Clients re-read it on their next launch or refresh (cached); phones keep the offline pack either way.
3. Verify: `GET https://<eas-host>/api/v1/config` returns the fallback URL; the web console loads tiles from R2; a phone shows tiles after a refresh.
4. Back: reset the setting to the default. Attribution stays visible either way ("© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors", or "© OpenMapTiles © OpenStreetMap contributors" for the self-hosted bundle); `src/ui/HazardMap*.tsx` and `src/services/mapOffline.ts` are the only places that know the provider.
5. The drill "switch to fallback and back" runs together with the M3 restore drill.

## 10. 10DLC status

US A2P 10DLC brand + campaign registration (or toll-free verification) is submitted in M0 once its prerequisites exist (plan §3.12, §23.H). Until approval Twilio **blocks** unregistered traffic outright (errors 30034/30032) — no SMS leaves our number; push/email/inbox carry everything, and phone verification goes through Twilio Verify (exempt), so S-11 works regardless. `tenant.sms_enabled` stays `false` in production until "approved".

| Item | Value / status | Date |
|---|---|---|
| Prerequisites on the first preview deploy: public `/privacy` + `/terms` with the SMS program description, "Msg & data rates may apply", "Reply STOP to opt out, HELP for help", the no-sharing sentence, a hosted S-11 opt-in mock and two sample messages | — | — |
| D14 (owner): registrant for the brand (city EIN vs vendor EIN) and sender type (local 10DLC Low Volume Mixed vs toll-free) | — | — |
| Twilio account SID (one account shared by preview and production) | — | — |
| Messaging Service SID / Verify Service SID | — / — | — |
| +1 number | — | — |
| Brand registration | not submitted / pending / approved | — |
| Campaign registration (use case: public-safety notifications, opt-in via S-11 phone verification) | not submitted / pending / approved | — |
| Toll-free verification (alternative) | — | — |
| Opt-in language on file | "Reply STOP to opt out" in every first SMS; verification code copy | — |
| First blocked-traffic check (Twilio logs, errors 30034/30032) | — | — |

Update this table at every status change; `tenant.sms_enabled = true` only after "approved".

## 11. R1 spike results (to be filled)

R1 = the EAS Hosting (workerd) spike from plan §3.1: multipart photo upload + a PostGIS query from an Expo API route, plus the pg_cron/pg_net availability check on Free. Fill in the measured facts; the fallback if any row fails is the `@expo/server` Node adapter on Fly.io/Railway.

| Check | Result | Measured | Date |
|---|---|---|---|
| `POST /api/v1/photos` multipart ≤ 600 KB on EAS Hosting | — | p50 / p95 ms | — |
| `GET /api/v1/reports?bbox` → `reports_in_bbox` RPC on EAS Hosting | — | p50 / p95 ms | — |
| Request time budget observed on workerd (max request duration, memory) | — | — | — |
| `create extension pg_cron` / `pg_net` on a Free project (record the installed `pg_net` version, plan §23.G) | — | — | — |
| `cron.schedule` → `net.http_post` → `/api/jobs/tick` round trip; pg_net timeout 25 s, the tick returns within 20 s (plan §23.G) | — | ms | — |
| Backup dry run through the pooler URL (`pg_dump` size, duration) | — | — | — |
| Twilio REST send + status callback from a route | — | — | — |

## 12. Exiting read-only mode

A Free project over its database quota is switched to read-only (every write fails with `cannot execute … in a read-only transaction`; plan §23.G). Either upgrade (plan §21 expects Pro during the pilot) or free space:

```sql
set session characteristics as transaction read write;   -- this session only
delete from rate_limit_counter where window_start < now() - interval '2 days';   -- and whatever else purgePhotos / coarsenGps would have removed
vacuum;
select pg_size_pretty(pg_database_size(current_database()));
```

The platform lifts read-only mode once usage is back under the limit (minutes; the dashboard shows it). Then check `GET /api/health` (`usage.dbPct`) and the stale `jobs.*.last_ok_at` the outage left behind.

## 13. Weekly egress reading

Egress is not visible from SQL (plan §23.G): read Dashboard → Usage once a week and record it here; the nightly dump counts too.

| Week | Egress (GB) | DB size (MB) | Storage (MB) | Notes |
|---|---|---|---|---|
| — | — | — | — | — |

## JWT signing keys (both Supabase projects, before the first preview deploy)

`src/server/auth.ts` verifies Supabase access tokens against the project's JWKS and accepts only asymmetric algorithms (ES256/RS256), never the legacy shared HS256 secret. In Supabase → Authentication → JWT Keys, make sure the project uses asymmetric signing keys (new projects do by default; older ones must rotate from the legacy secret). With HS256 still active every authenticated request returns 401.

## Auth providers (both Supabase projects, before the first M1 preview build)

What `src/services/auth.ts` expects from the dashboard (plan §3.4, §23.B, §23.C, §23.E). Do preview first, then production; the two projects differ only in the redirect URLs that carry the deployment host. Client ids are public configuration and go into `EXPO_PUBLIC_*`; the Apple key and the Resend key are server secrets (`eas env:set … --visibility sensitive`).

### 1. Sign in with Apple (iOS only; Guideline 4.8 binds iOS, so Android is not offered Apple)

1. Apple Developer → Certificates, Identifiers & Profiles → Identifiers → the App ID `com.27363.rootcause` → enable **Sign In with Apple** (the dev client's bundle id too, if it differs). `app.json` already carries `ios.usesAppleSignIn: true` and the `expo-apple-authentication` plugin.
2. Keys → **+** → Sign In with Apple → download the `.p8` once. Note the **Key ID** and the **Team ID** (top right of the developer account).
3. Supabase → Authentication → Providers → **Apple** → enable. **Client IDs** (comma-separated) = every bundle id that will present the native sheet: `com.27363.rootcause` plus the dev-client bundle id. Leave "Secret Key (for OAuth)" empty — the app uses the native `signInWithIdToken` flow, no web OAuth.
4. Server env (plan §23.C token revocation on deletion): `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (the `.p8` contents; EAS stores the newlines as `\n`, the server unescapes them), optional `APPLE_CLIENT_ID` when the build's bundle id is not `com.27363.rootcause`. Without the three values `POST /api/v1/me/apple-link` answers 503 and `DELETE /api/v1/me` skips the revoke call and logs `apple.revoke_skipped`.
5. Check: sign in with Apple on a device → `select auth_provider, apple_refresh_token is not null as linked from app_user order by created_at desc limit 1;` shows `apple | true` within a few seconds (the app posts the authorization code right after sign-in; Apple accepts it for 5 minutes).

### 2. Google (iOS and Android native; web console in M2)

1. Google Cloud console → APIs & Services → Credentials → OAuth consent screen (external, app name RootCause, the privacy URL from the deployment).
2. Create OAuth client IDs:
   - **iOS**: bundle id `com.27363.rootcause` (and the dev client's). → `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`.
   - **Android**: package `com.tstst.rootcause`, one client per signing key — the EAS preview keystore SHA-1, the EAS production keystore SHA-1 (`eas credentials`), and the Play App Signing SHA-1 (Play Console → Setup → App signing). → `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` (informational; the SDK binds by package + SHA-1).
   - **Web application**: no redirect URIs needed for the native flow. → `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`. This is the audience of the id tokens the Android SDK returns, so Supabase must know it.
3. Supabase → Authentication → Providers → **Google** → enable; **Client ID (for OAuth)** = the web client id; **Authorized Client IDs** = the iOS client id(s) and the web client id (comma-separated). Turn **Skip nonce check** on only if the Google SDK on Android stops sending one (it does today, so leave it off).
4. `app.json` needs the config plugin entry with the reversed iOS client id as the URL scheme (replace the placeholder with the iOS client id reversed):

```json
["@react-native-google-signin/google-signin", { "iosUrlScheme": "com.googleusercontent.apps.<ios-client-id-prefix>" }]
```

5. Check on both platforms: `GoogleSignin.signIn()` returns an `idToken`; `signInWithIdToken` creates the `auth.users` row with `raw_app_meta_data->>'provider' = 'google'`; `app_user.auth_provider` reads `google` (trigger in `0001_init.sql`).

### 3. Email codes (every platform) — SMTP, template, expiry, redirects (plan §23.B)

Supabase's built-in mailer sends 2 emails/hour to organisation members only, so the hosted projects must use our SMTP:

1. Resend → Domains → add the sending domain of `STAFF_EMAIL_FROM` and finish DNS (SPF, DKIM, the return-path CNAME). Resend → API Keys → a key scoped to sending.
2. Supabase → Project Settings → Authentication → **SMTP Settings** → enable custom SMTP: host `smtp.resend.com`, port `465` (or `587` STARTTLS), user `resend`, password = the Resend API key, sender = `STAFF_EMAIL_FROM`, sender name `RootCause`. Minimum interval between emails: 60 s is the dashboard default and fine.
3. Authentication → **Rate Limits** → "Rate limit for sending emails" → the expected sign-in peak (start at 60/hour; raise before a launch day). Resend Free is 100/day and 3,000/month across sign-in codes, staff paging and injury notices — budget the paid tier before the pilot (plan §21, R19).
4. Authentication → **Email Templates** → **Magic Link** *and* **Confirm signup** (a new address triggers the signup template; `verifyOtp({ type: 'email' })` accepts both): subject `Your RootCause sign-in code`, body = `supabase/templates/email-code.html` — it shows `{{ .Token }}` as a 6-digit code and keeps `{{ .ConfirmationURL }}` for the link variant. Local `supabase start` already uses this file through `config.toml`.
5. Authentication → **Providers → Email**: enabled; "Confirm email" off (codes are the confirmation); **Email OTP Expiration** `600` seconds; **Email OTP Length** `6`; "Secure email change" on.
6. Authentication → **URL Configuration**: Site URL = the deployment (`https://<eas-host>`); **Redirect URLs** = `rootcause://auth/callback`, `https://<eas-host>/auth/callback` and, for preview only, `http://127.0.0.1:8081/auth/callback` and the dev client's `exp://…/--/auth/callback`. The app sends `emailRedirectTo: rootcause://auth/callback` from the phone and `<origin>/auth/callback` from the web; a URL that is not listed falls back to the Site URL and the link variant breaks (the typed code still works).
7. Authentication → **JWT Keys**: asymmetric signing (ES256/RS256) must be active — `src/server/auth.ts` refuses HS256 (see the section above).
8. Check: request a code from the sheet → the email arrives from `STAFF_EMAIL_FROM` with a 6-digit code within a minute; typing it signs in; opening the link on the device lands on `/auth/callback` and signs in too; `/api/v1/me` returns `provider: "email"`.

### 4. Account deletion (App Store requirement; plan §23.C)

`DELETE /api/v1/me` revokes the Apple token (best effort), runs `deidentify_user()` (migration `0002_me.sql`, one transaction) and calls `auth.admin.deleteUser`. Verify once per environment: delete a test account from Settings → `select deleted_at is not null, display_name is null, phone_e164 is null from app_user where id = '<uid>';` → `true | true | true`; `select count(*) from auth.users where id = '<uid>';` → `0`; the account's reports are still there with `reporter_id is null`.
