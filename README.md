# RootCause

Report a sidewalk, tree, road, drain or lighting hazard in under a minute, see exactly why it ranks where it does, and get warned before tonight's rain turns an open report into an incident. A resident app plus a public-works console for New Brunswick, NJ. Congressional App Challenge 2026 · NJ.

**One claim.** Someone trips on a sidewalk slab lifted by a tree root. That hazard was visible for months, was probably already reported, and was never ranked against anything. The failure is not a shortage of complaints; it is that neighbourhood knowledge never becomes a prioritised, weather-aware, auditable signal. RootCause turns a photo into a work order with a five-term priority score that every resident and every inspector can read, keeps the intake working with no signal, and joins the open backlog to the NWS forecast so the city can act before the storm — with rules it can show a council, not a model it has to trust.

**Status (M0).** Foundations: domain modules (score, status machine, roles, votes, SLA, taxonomy), design tokens and widgets, local storage, store, sync queue, and the first screens rendering from local data (Home, Map as a list, Alerts, Me, report detail, capture scaffold, onboarding, Offline data, Privacy, Why this score). Server side: the first migration (`supabase/migrations/0001_init.sql`), `/api/health` and `/api/v1/reports` on memory and Supabase repos, JWT verification and CI (`.github/workflows/ci.yml`); no photo upload, sign-in, map view, console or jobs yet. The table below is the v1 scope the code is built to; [docs/gap-analysis.md](docs/gap-analysis.md) says row by row what exists today and when the rest is planned.

## What it does (v1)

| Tab / screen | What it shows | Offline? |
|---|---|---|
| S-00 Onboarding `/onboarding` | Home watch area (map tap or "use my location"), the categories you care about, quiet hours. No sign-in here; notification permission is asked later, on your first follow or vote. | Yes — everything stays on the phone |
| **Home** S-01 `/` | Active storm advisory (M4) or the neighbourhood open-hazard index with its named drivers; nearby reports ranked by urgency / distance / newest with an inline vote; "your votes moved N orders" barometer. | Yes — cached feed, "Reports saved 12 min ago · no signal" |
| **Map** S-02 `/map` | MapLibre map; pins coloured by severity band and sized by votes, clustered at low zoom; category chips; tap → peek card → detail; "Report what I see here" pre-fills the location. No heat layer in v1. | Yes — cached pins render without tiles; optional offline tile pack from Offline data |
| **Report** S-04 Capture `/report/capture` | One tap from the tab bar to the camera (or the library); guidance text per category; the photo is resized to ≤ 1280 px / ≤ 500 KB, EXIF dropped, and saved as a draft on disk. | Yes — draft on disk |
| S-05 Analysis `/report/analysis` | Exactly the image that uploads; proposed category / sub-type (and species for vegetation) with a confidence, or "unclear"; duplicate candidates within 25 m ("Add to that report" attaches the photo and counts as a vote). | Partly — "Analysis runs when you're back online; you can still file now" |
| S-06 Form `/report/form` | Prefilled and correctable: category, sub-type, "How dangerous right now?" (Annoying / Risky / Someone will fall / Emergency), "Has anyone been hurt?" (No / Near miss / Injury), approximate address, note, identity (Named / Initials / Anonymous). Emergency shows the 911 line. Submit asks you to sign in here and only here, and keeps the draft. | Yes — form without proposals; Submit queues the draft |
| S-07 Submitted `/report/submitted` | Score with its five terms, rank among open orders in the category, next steps by SLA band, share link. | Partly — "Saved on this phone · sends when online"; score and rank arrive when the server accepts it |
| S-08 Report detail `/report/[id]` | Released photos, badges, vote meter (n of 25), score card → "Why this score", the AI read labelled as a proposal, status timeline in resident wording, comments (public record), nearby related orders, follow, flag. | Yes for cached reports — votes, comments and follows queue; photos only if already loaded |
| **Alerts** S-03 `/alerts` | Status alerts on your own and followed reports; storm advisories (M4); chips All / Storm / My reports; link to your alert rules. | Yes — inbox stored on the phone |
| S-09 Alert briefing `/alert/[id]` | Why you got this, the specific spots, what the city is doing (M4). | Yes — from the inbox cache |
| **Me** S-10 `/me` | Reports filed / resolved / votes cast, median days-to-resolve vs citywide, my reports (including local-only anonymous ones), data export, "Delete my data" (de-identifies), privacy. Signed out: "Sign in to vote and follow". | Yes — stats cached; the local list comes from the phone |
| S-11 Settings `/settings`, `/watch-areas`, `/phone` | Watch areas (home / work / route-lite / custom radius), categories, quiet hours, phone number + SMS opt-in verified by a 6-digit code, staff sign-in. | Mostly — preferences save locally and sync; the SMS code needs a signal |
| S-12 Offline data `/data` | What is saved, how big and when; "Simulate no signal"; demo scenarios; failed drafts with their reason; offline map pack download / remove with its size; reset. | Yes |
| S-13 Privacy / Terms `/privacy`, `/terms` | Photo handling, what is shared, 7-year retention, SMS terms, no sharing with enforcement agencies, contact. | Yes — bundled text |
| S-14 Sign-in `/sign-in`, `/auth/callback` | Apple, Google or email code; says why ("one vote per person; your reports stay yours"); returns to where it was opened. | No — needs a signal; the draft waits |
| Why `/why/score/[id]`, `/why/index` | The weights, the five terms and this report's numbers; the open-hazard index definition. | Yes — constants from the bundle |

The DPW console (`/console/*`, web only, staff sign-in) ships the spec's O1–O4, O10 and O12 views plus moderation, users and settings in M2–M3; O6 weather scenarios and O11 alert composer are the M4 cut line. Public web pages: `/r/[id]` (one report) and `/equity` (the gap table). Plan §10 lists the views.

Not in v1 (on purpose), each with the plan's reason (§20):

- **Cityworks / Cartegraph sync** (spec §14 Phase 1) — "no vendor sandbox or credentials for the pilot"; RootCause owns the work order and ships the `WorkOrderSync` seam and the status-mapping table now. Open311 GeoReport v2 in and out is in.
- **Submitting a report without any account** (spec §11 Anonymous role) — owner decision D3: accounts are required for every write. The *Anonymous identity* on a report remains, and the server stores no link between such a report and the account.
- **Languages beyond English** (spec §12 EN/ES/ZH/VI) — owner decision D6; a typed catalog is the intended shape when Spanish returns.
- **Voice alert channel** (spec §5) — "SMS covers the degraded path; voice needs an IVR vendor".
- **Face / plate blur** (spec §13) — "needs an on-device ML module or a vision service"; instead photos are staff-only until an inspector releases them at triage.
- **Address verification for voting** (spec §4.3) — "participation vs integrity trade-off left to the city".
- **Full VPAT** (E12) — `docs/accessibility.md` conformance notes instead.
- **Spec Phase 2/3** (§14): bundling suggestions, crews & dispatch (O5), urban forestry (O7), allergen / pollen (O8, R10–R12), budget & CIP (O9), the on-device live detector, species ID at quality, millimetre severity, the incident/recurrence model and risk heat layer, trust score, device-fingerprint anomaly detection beyond the simple flags, multi-tenant deployment, SOC 2. The spec's own sequencing: "Ship trip hazards first; that is where the injury, the claim and the budget are."

## Where the AI is (and is not)

- **One place:** `src/app/api/v1/vision/analyze+api.ts` (M3) — a server route that sends one resized photo plus its coordinates to **Claude Haiku 4.5** (`claude-haiku-4-5` through the official Anthropic TypeScript SDK; `VISION_MODEL` is a server env var) and gets back a proposed category, sub-type and, for vegetation, a species guess, each with a confidence. Output is constrained to the taxonomy enums in `src/domain/taxonomy.ts` by structured output and re-validated with zod; anything else is discarded. The same route returns duplicate candidates, which come from a PostGIS radius query, not from the model.
- **Flagged and bypassable.** `VISION_ENABLED` on the server and `EXPO_PUBLIC_VISION` in the app. 8 s timeout, after which the form opens without proposals; offline, the step is skipped. The report flow is identical with the route off — a screens test asserts it.
- **Floors.** Confidence below 0.70 renders "unclear — pick a category". Hazardous taxa (giant hogweed, poison hemlock) are never auto-confirmed. The model never outputs a displacement or millimetre figure (spec §8 degrade rule; v1 has no calibration data). Severity band 4 exists only after a human confirms it. Every resident correction is stored in `vision_feedback`.
- **Breaker.** `VISION_DAILY_MAX` (default 500/day) turns the route off for the rest of the day with `{disabled: true}` and the app continues. At Haiku 4.5 rates ($1 / $5 per MTok) one analysis is about 2.5k input tokens plus a few hundred output tokens — $0.003–0.005 — so the breaker caps spend near $2.50/day.
- **Nowhere else.** The priority score is five weighted terms in `src/domain/score.ts` — `100 × Σ(w·term) × stormMultiplier`, weights .32 severity / .24 exposure / .22 community / .14 liability / .08 decay — and `/why/score/[id]` prints them. Status changes are a state machine (`src/domain/status.ts`). Storm scenarios are rules: NWS forecast thresholds × the open reports' sensitivity tags, labelled "rules-based: forecast × open backlog". Alert, push and SMS copy is templated. Addresses are the nearest bundled OSM address point, labelled approximate. Nothing here trains a model.

## Where the server is (and is not)

- **Expo API routes on EAS Hosting, in front of Supabase Free.** `src/app/api/**/+api.ts` (`/api/health`, `/api/v1/*`, `/api/open311/v2/*`, `/api/webhooks/twilio`, `/api/jobs/tick`) are the only API. They run on workerd, so there is no in-memory state: rate limits and job cursors live in Postgres. Behind them Supabase provides Postgres + PostGIS (duplicates, bbox feeds, audiences, block-group joins), Auth (Apple / Google / email code), a private Storage bucket (photos, 1-hour signed URLs) and pg_cron → pg_net calling `/api/jobs/tick` every minute. Two projects: preview and production. Only the routes hold the service key, and `getRepos()` fails closed with 503 when env is missing.
- **What the phone sends.** The resized, EXIF-stripped photo; the report fields and your two answers; votes, comments, follows, verifications; watch areas you choose to save; a push token after your first follow, vote or report; your phone number only if you opt in to SMS; the Supabase session token; an install id as an extra rate-limit dimension. It never sends your home area unless you save it as a watch area.
- **What the phone holds.** Drafts and their photos (`Paths.document/drafts/`), the cached feed and alerts as time-stamped GeoJSON, preferences, the session, the local link that lets "My reports" list your anonymous reports, and the optional offline map pack — in `expo-sqlite/kv-store` + `expo-file-system`, hydrated synchronously before the first frame.
- **Every public response** (`/v1/reports`, `/r/[id]`, Open311, exports) goes through `toPublicReport()`: 50 m snapped-and-jittered points for account-linked reports, no home areas, no phone numbers, no internal notes, no staff-only photos, no install ids.

External APIs: NWS, Anthropic, Twilio, Resend · API keys needed by the phone: 0 (one publishable Supabase key + OAuth client IDs) · Server routes: see `src/app/api`.

## Stack

Expo SDK 57 · expo-router · React Native 0.86 · TypeScript (strict) · zod 4. Local storage is `expo-sqlite/kv-store` (synchronous reads, so the first frame renders from disk) plus `expo-file-system` for draft photos and the map pack; web falls back to localStorage. Map: `@maplibre/maplibre-react-native` on the phone and `maplibre-gl` in `HazardMap.web.tsx` for the console, both reading the same OpenFreeMap style URL and the same GeoJSON source with MapLibre clustering — no API key. Auth: supabase-js for Auth only (storage adapter over kv-store), `expo-apple-authentication`, Google id tokens. Camera `expo-camera`, resize `expo-image-manipulator`, push `expo-notifications`, best-effort background flush `expo-background-task`. Clock: `America/New_York` via Intl. Server: Expo Router API routes, `@supabase/supabase-js` with the service key, Anthropic TypeScript SDK, Twilio and Resend over REST, NWS with a `User-Agent`.

Same design system as the sibling projects `nmi-typhoon-watch` and `studyspace`: native iOS grouped-list idiom, one accent — RootCause green `#1F6B4F`, which also means "good / verified" — and three semantic colours (red = critical / emergency / SLA breached · amber = high severity, at risk, stale data · blue = storm and forecast context, moderate severity). Severity is never colour alone (`SeverityBars`, n of 4, with a label; map pins carry a text label in the peek card), no shadows, 44 pt targets, body ≥ 15 pt, tabular numerals, no spinners, every cached thing time-stamped, every score shows its terms, demo data labelled wherever it appears.

## Run it

```bash
npm install
cp .env.example .env        # EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY for sign-in; server variables for the API routes
npx supabase start          # Docker: local Postgres + Auth + Storage with supabase/migrations applied
npx expo run:ios            # or run:android — builds a development client, then starts Metro
```

Expo Go cannot run this app: MapLibre, Sign in with Apple and the notification channels are native modules, so use a development build (`npx expo run:ios` / `npx expo run:android`; later `npx expo start` opens it). The API routes run on the Metro dev server during `expo start` (`web.output` is `server`), so the phone and the console at `http://localhost:8081/console` talk to the same local routes; `EXPO_PUBLIC_API_URL` is only needed when the routes run elsewhere. Vision assist needs `ANTHROPIC_API_KEY`; without it the flow is the manual one.

## Verify

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # expo lint, including the src/server import boundary
npm test            # jest, no network, no Docker: domain (score, status, votes, audience, channels, scenario, sla, moderation, geo, time),
                    #   routes (new Request() against memory repos), screens (renderRouter × scenario × offline × signed-in/out, zero fetch offline),
                    #   boundary, bundled data, storage guard
npm run test:int    # Docker (npx supabase start first): migrations, RPCs, append-only triggers, RLS, rate-limit concurrency, anonymous unlinkability
npm run perf:queue  # M2+: p50/p95 of /api/v1/ops/queue against 200k seeded reports → docs/perf.md
```

CI (`.github/workflows/ci.yml`) runs the same plus an export smoke test — `expo export --platform web`, serve `dist`, request `/api/health`, `/api/open311/v2/services.json`, `/api/open311/v2/requests.json` and `/console` — and a secret grep over `dist/`.

Device procedures T1–T19, the nine-state matrix, the demo script and the deep links are in [docs/QA.md](docs/QA.md).

## Build, deploy, release

Identifiers: iOS `com.27363.rootcause`, Android `com.tstst.rootcause` (`app.json`). Profiles in `eas.json`: `development`, `development-simulator`, `preview`, `production`; EAS CLI 16 or newer (`npm i -g eas-cli`). `preview` and `production` map one-to-one to the two Supabase projects, the two Twilio Messaging Services and the two EAS environments.

**1. Link the project (once)**

```sh
eas login
eas init            # writes extra.eas.projectId into app.json
```

**2. Database.** `supabase/migrations` is the only schema source: `npx supabase link --project-ref <preview-ref> && npx supabase db push`, then the same for production after review. Every migration must keep the previous native build working (expand → migrate → contract).

**3. Server variables.** EAS Hosting reads them from the EAS environment, not from `.env.local`; secrets are stored as `sensitive`.

```sh
for name in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY ANTHROPIC_API_KEY TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_MESSAGING_SERVICE_SID RESEND_API_KEY JOB_SECRET OPEN311_API_KEYS SENTRY_DSN_SERVER; do
  eas env:set --name $name --value <value> --environment production --visibility sensitive
done
eas env:set --name VISION_MODEL --value claude-haiku-4-5 --environment production --visibility plaintext
# plaintext as well: VISION_ENABLED, VISION_DAILY_MAX, SMS_ENABLED, STAFF_EMAIL_FROM, NWS_USER_AGENT

npx expo export --platform web
eas deploy --prod --environment production      # prints https://<name>.expo.app
```

Check it: `curl https://<name>.expo.app/api/health` answers with the version, `db: ok`, the forecast age, `jobs: {name: last_ok_at}` and database / Storage usage. Point the uptime monitor at this URL every 5 minutes for both projects — it doubles as the Supabase Free keep-alive.

**4. Point the app at it.** `EXPO_PUBLIC_*` values are inlined at build time and are configuration, not secrets.

```sh
eas env:set --name EXPO_PUBLIC_API_URL --value https://<name>.expo.app --environment production --visibility plaintext
# likewise: EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY, EXPO_PUBLIC_GOOGLE_{IOS,ANDROID,WEB}_CLIENT_ID,
#           EXPO_PUBLIC_MAP_STYLE_URL, EXPO_PUBLIC_VISION, EXPO_PUBLIC_PILOT, EXPO_PUBLIC_SENTRY_DSN
```

Repeat step 4 with `--environment preview` and `--environment development` for those profiles.

**5. Builds**

```sh
eas build --profile development --platform ios            # dev build for a real iPhone (camera, MapLibre, Apple sign-in, T1–T19)
eas build --profile development-simulator --platform ios  # same, for the iOS Simulator
eas build --profile preview --platform android            # installable APK
eas build --profile production --platform all             # store builds, version auto-incremented
eas submit --profile production --platform ios            # TestFlight / App Store
eas submit --profile production --platform android        # Play Console
```

Release gate (plan §15, M5): T1–T19 recorded in `docs/QA.md`; App Store privacy labels and Play Data Safety filled in (phone number, photos, location); `docs/privacy.md` and `docs/terms.md` reviewed by the city attorney (D12); one restore from the nightly backup performed and recorded in `docs/runbook.md`; 10DLC registration status noted.

## Demo scenarios

Offline data → **Demo & testing** → Calm / Storm / Verify. `storm` loads an archived NWS gridpoint forecast shifted to tonight plus demo-labelled reports, so the scenario card, the storm-sensitive filter and the multiplier can be shown at any time of day. `verify` puts one report in `completed` with the crew's after-photo, awaiting your confirmation. `calm` shows the neighbourhood index card and no hero. Demo reports are labelled wherever they appear and are never uploaded; demo mode works signed out (reads only) and signed in. "Simulate no signal" shows the OFFLINE banner and blocks every network call inside the app; the real test is airplane mode.

Deep links do the same: `rootcause://?demo=storm` (also `calm`, `verify`), `rootcause://report/<id>`, `rootcause://map?cat=vegetation`. On the iOS Simulator with Metro running: `xcrun simctl openurl booted "exp://127.0.0.1:8081/--/?demo=storm"`.

## Data and licences

- Map tiles: OpenFreeMap `liberty` style (`EXPO_PUBLIC_MAP_STYLE_URL`), no key, no SLA. The attribution "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors" is visible in every map state, including offline. Your phone fetches tiles from OpenFreeMap directly. Fallback: a self-hosted Protomaps PMTiles extract of the pilot area behind our own `style.json` — an env change.
- Exposure and reverse-geocoding data: OpenStreetMap via the Overpass API (`scripts/build-osm.ts` → `assets/data/osm/<pilot>.json`), © OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright. The extract is a derivative database and stays under ODbL. Pedestrians/day per road class are placeholder estimates labelled "estimated from map data" until the city supplies counts.
- Weather: NWS `api.weather.gov` gridpoint forecast (public domain), fetched server-side every 15 minutes with the required `User-Agent`; `probabilityOfPrecipitation` is the confidence for rain scenarios; a staleness badge appears past 60 minutes.
- Census: TIGER/Line block groups and ACS 5-year population and median household income for Middlesex County, NJ (public domain), loaded by `scripts/build-census.ts`. Reports per 1k residents use these denominators.
- Taxonomy, SLA table and remediation options come from the spec; unit costs, recurrence months and every prototype figure are "plausible placeholders" (spec, closing note) to be replaced with the pilot city's own numbers.
- Demo data is fabricated and labelled. The spec's "City of Elmwood" is fictional; the pilot area is New Brunswick, NJ (owner decision D1). No partnership with or endorsement by the city is implied.
- Evidence trail, read dates and what the app does not claim: [docs/data-sources.md](docs/data-sources.md).

## Project layout

```
src/app/            expo-router screens: (tabs)/, report/, alert/, why/, console/ (web), r/[id] + equity (public web)
src/app/api/        server routes: health, v1/** (photos, reports, vision, me, ops, scenarios, alerts, export), open311/v2, webhooks/twilio, jobs/tick
src/domain/         pure logic: types + zod, taxonomy, score, status machine, roles, votes, audience, channels, scenario, sla, moderation, geo, time, ids, demo
src/data/           local storage (kv + files, with .web.ts fallbacks) and repositories (drafts, mutations, cache, prefs, watch areas, session, map pack)
src/services/       API client, auth, photos, sync queue, refresh, network, location, camera, notifications, map offline, demo
src/server/         server-only: db, auth, rate limit, photos/exif, public projection, push, sms, email, nws, vision, repos (+ memory), sync seam, jobs
src/store/          useSyncExternalStore app store + derived hooks
src/ui/             theme tokens, primitives, icons, severity/score/report widgets, HazardMap (+ .web), console/ components
assets/data/        taxonomy, sla, remediation options, wards, block groups, osm/<pilot>, demo/
supabase/           config, migrations (the only schema source), seed
scripts/            build-osm, build-census, seed-demo, seed-synthetic, perf-queue, grant-role, backup.sh
__tests__/          domain, routes (new Request()), screens, bundled data, storage guard, boundary, public projection
docs/               QA.md · data-sources.md · privacy.md · terms.md · gap-analysis.md · runbook.md · (M1+) taxonomy.md · accessibility.md · perf.md
```
