# RootCause v1 — Production Plan (Expo SDK 57 + TypeScript)

**Status:** approved for execution on 2026-10-05 (owner: "코드 작업 시작"); M0 in progress. Revision 4 (owner decisions D1–D13 applied; two Critic passes on rev 2; six-lens adversarial verification on rev 3 → §23 supersedes any conflicting text above it).
**Date:** 2026-10-05
**Spec:** `../docs/3_NewJersey_2.HTM` — "RootCause — Predictive Civic Hazard Platform (Interactive Prototype v0.9)". Design tokens lines 7–50; resident screens 566–1326; DPW console 1402–2150; handoff §1–§17 at 2153–2571; prototype mock data 2583–2760; prototype screen notes (`RES_NOTES`) ~2765–2780.
**Reference apps:** `../nmi-typhoon-watch` (clean working tree — copy template files from here) and `../studyspace` (same template; **has uncommitted edits from another agent run** — copy only from `git show HEAD:<path>`).
**Staffing assumption:** 2 full-time engineers (one mobile/UI, one backend/console) plus part-time design/QA. With 1 engineer, M4 is cut and the 12 weeks end at M3 + release.

---

## 0. Summary

1. **One Expo codebase, three surfaces.** Resident app (iOS/Android), DPW console (web, same repo, `/console/*`), and the API (Expo Router `+api.ts` routes). All three import the same pure domain code (`src/domain`), so the five-term priority score renders identically on the phone, in the console, and on the server.
2. **Backend = Expo API routes in front of Supabase (Free plan, two projects).** Supabase provides Postgres + PostGIS, Auth (Apple / Google / email), Storage, pg_cron. Only the API routes hold the service key. The phone talks to `/api/v1/*` with plain `fetch` + zod (the sibling `crowdClient` pattern); the only key on the phone is Supabase's publishable key plus OAuth client IDs (configuration, not secrets).
3. **Accounts are required for every write** (D3): report, vote, comment, follow, verify. Browsing is open. A report can still be filed under the "Anonymous" identity, and the server then stores no link between that report and the account (unlinkability rule, §3.4).
4. **Scope = spec Phase 1 ("better intake, ranked", §14) in 12 weeks, plus rules-based weather scenarios as the declared cut line.** Scenarios join real NWS forecasts to the open backlog by declared sensitivity tags — no learned model. SMS via Twilio is in (D11). Forestry, pollen, bundling, crews, budget/CIP, on-device vision, the incident model, voice channel and non-English copy are deferred (§20).
5. **Map = MapLibre with OpenStreetMap-based vector tiles (OpenFreeMap, no key)** on native and web (D2) — a disclosed deviation from the siblings' bundled SVG maps; offline behaviour is defined in §9.6.
6. **AI in exactly one place, bypassable.** `POST /api/v1/vision/analyze` proposes category/sub-type (and a species guess for vegetation) from a photo via Claude Haiku 4.5 (D4) and returns duplicate candidates (spec §10 line 2435). Confidence floors, enum-constrained output, a daily spend breaker, never a millimetre number. The report flow works with the route off.
7. **Inherited honesty rules** (siblings' READMEs and `docs/QA.md`): offline-first intake, every cached thing time-stamped, no spinners, every score shows its terms, demo data labelled wherever it appears, `.env` never committed.
8. **Production additions the siblings never needed** (deliberate deviations): CI, preview/production projects, staged migrations, nightly DB + Storage backups to an external bucket (the Free plan has no backups of its own), error tracking, uptime checks that double as keep-alive pings, a moderation queue (App Store Guideline 1.2), and an on-call paging path (push + SMS + email) for emergencies.

---

## 1. Requirements summary (what v1 must do)

Source: spec §3 screen inventory (line 2178), §4 flows (2222), §14 Phase 1 cut (2502), §17 backlog (2549).

### 1.1 Resident app (MVP rows of §3, trimmed per §14)

| Spec | Screen | v1 behaviour |
|---|---|---|
| R1 | Home / feed | Active scenario card (if any), neighbourhood open-hazard index with named drivers, ranked nearby reports with inline vote, "your votes moved N orders" barometer |
| R2 | Map | MapLibre map with OSM-based tiles; pins coloured by severity band and sized by votes, clustered at low zoom; category filter; tap → peek → detail; "Report what I see here" pre-fills location. No heat layer in v1 (prototype R2 note: heat must be modelled risk, never report density) |
| R3 | Capture | Camera or library, guidance text per category, works offline (draft queued). No live on-device detector in v1 |
| R4 | Analysis | Server vision assist (flagged, online only): proposed category/sub-type/species with confidence; duplicate candidates within 25 m ("Add to that report" attaches photo + counts as a vote); approximate address from bundled map data; offline → skipped, duplicates found server-side at submit for staff merge |
| R5 | Form | Prefilled, correctable; "How dangerous right now?" (Annoying / Risky / Someone will fall / Emergency) and "Has anyone been hurt?" (No / Near miss / Injury); identity Named / Initials / Anonymous; free text optional; "If anyone is in danger right now, call 911" shown when Emergency is selected; **sign-in is requested at the first server write, never in onboarding** — online that is the photo upload right after the shutter (S-14 sheet, then S-05); offline it is this screen's submit (the draft is already on disk and survives sign-in) |
| R6 | Submitted | Score with five terms, rank among open orders in category, next steps by SLA band, share link; offline → "Saved on this phone · sends when online" |
| R7 | Detail | Photos (after moderation release), AI read, vote with 25-vote meter, comments (public record), status timeline, nearby related orders, follow, flag |
| R8 | Alerts inbox | Status alerts on own/followed reports; scenario advisories (M4); filter chips; link to rules |
| R9 | Alert briefing | "Why you got this", the specific spots, what the city is doing (M4) |
| R13 | Profile / impact | Reports filed / resolved / votes cast, median days-to-resolve vs citywide, my reports (incl. local-only anonymous), data export, delete my data (de-identify), privacy |
| R14 | Settings | Watch areas (home / work / route-lite / custom radius), categories, quiet hours, **phone number + SMS opt-in (verified by a 6-digit code)**, staff sign-in link |
| — | Sign-in, Onboarding, Offline data, Privacy, Terms | S-14 sign-in (Apple / Google / email code), sibling pattern screens (S-00, S-12, S-13) + web `/terms`, `/privacy` |

### 1.2 DPW console (MVP rows of §3)

| Spec | View | v1 behaviour |
|---|---|---|
| O1 | Overview | KPIs (open orders, median days to close, SLA breaches, verified closures), "needs a decision today" (emergencies pinned, then top by score), intake mix, backlog age by category |
| O2 | Triage queue | Sortable/filterable/searchable ranked table, storm-sensitive filter, duplicate clusters awaiting merge |
| O3 | Work order drawer | Evidence, "why it ranks here" (five bars), status transitions per state machine, severity confirm/override → `severity_audit`, log mitigation (stops liability clock), remediation option pick (recorded), merge, resident update (public) vs internal note (labelled records-request-visible), acknowledge emergency |
| O4 | Map | City-wide MapLibre map, layer toggles (reports / storm-sensitive), hot blocks list, **silent zones** panel with "Schedule inspection" (E10 inspection quota, v1 form) |
| O10 | Equity & SLA | Reports per 1k residents vs median days-to-close vs open-hazard index by ward/block group, gap column, SLA matrix performance (computed at read time) |
| O11 | Alert composer | M4: trigger → audience → severity/channel (push / push+SMS / all) → templated message → preview → test send / schedule / send; history & outcomes incl. SMS delivery status |
| O6 | Weather scenarios | M4: trigger conditions from NWS, matching open defects, generated pre-event work list, approve → work list + draft alert |
| O12 | Governance / integrations | Static: where AI is and is not, guardrails, status mapping table, data sources, exports, known failure modes |
| — | Moderation, Admin › Users, Settings | Flag queue + blocks (App Store 1.2); role grants, staff phone numbers and on-call rota (director); weights / SLA / scenario thresholds / vision daily max (audited) |

### 1.3 Core flows (§4)
- **Report** (4.1): open → camera → shutter → local draft (survives kill / no signal) → [online] sign in if not yet (S-14 sheet; Apple/Google is two taps; the draft is kept) → upload photo → vision assist (optional, ≤ 8 s) + duplicates → prefilled form → two human questions → submit → score + rank shown. Offline: form without proposals → sign in if not yet at submit → queue; uploads + create run when back online, exactly once. Every server write needs a session (D3); nothing is written before S-14 has been passed.
- **Vote** (4.3): signed-in account; one vote per account per report; geo check (home/watch area within 1.5 km, else accepted but flagged `unverified_geo`); weight 0.6 for accounts younger than 7 days or without a home watch area, 1.0 otherwise (spec range 0.6–1.3); community term recomputed; thresholds 25 → supervisor review flag, 100 → council item flag.
- **Verification** (4.4): completed + after-photo → reporter + the 5 earliest voters asked to confirm → 2 confirmations → verified; 1 rejection with photo → reopen to `assessed`, severity +1 band, supervisor notified; 14 days silence → auto-verify.
- **Emergency** (R5 copy line 779; O10 SLA 15 min; governance "no AI-only emergency" line 2034): resident selects Emergency → `emergency_requested` → report pinned to top of queue → on-call supervisor paged (push to staff devices + SMS + email) → acknowledge within 15 min, else re-page next in rota and the director → human confirmation sets severity 4 or downgrades. Injury answers notify the configured Risk Management addresses.
- **Predictive alert** (4.2, rules version, M4): 15-min NWS poll → scenario trigger crosses → select open defects by sensitivity tag → rank by score → work list → audience by watch areas ∩ hazard buffer, fatigue budget, quiet hours → human approval → delivery by channel policy (§11) 4 h before onset → post-event follow-up record.

### 1.4 Non-functional (§12, §13)
Offline-first intake; WCAG 2.2 AA, dynamic type to 200 % on body text, no colour-only encoding; **English only in v1 (D6; spec asks EN/ES/ZH/VI — deferred, §20.1)**; queue p95 < 400 ms at 200k reports; 99.9 % intake availability target (measured by uptime checks on `/api/health`); photos retained 7 years, anonymous-report GPS coarsened to 50 m after 30 days, audit log append-only and permanent; internal notes labelled as records-request-visible; anonymous reporting identity first-class; degraded alert path when push fails (SMS for opted-in users, email, inbox).

---

## 2. Conventions inherited from the siblings

Observed in `../nmi-typhoon-watch` and `../studyspace`; adopted unchanged unless §3 or §22 says otherwise.

| Area | Convention | Source |
|---|---|---|
| Versions | `expo ~57.0.26`, `react-native 0.86.3`, `react 19.2.3`, `expo-router ~57.0.24`, `typescript ~6.0.3` strict, `zod ^4`, `jest-expo ~57`, `eslint-config-expo/flat` | `../nmi-typhoon-watch/package.json` |
| Scripts | `start/android/ios/web`, `lint: expo lint`, `test: jest`, `test:watch`, `typecheck: tsc --noEmit` | same |
| Config files copied verbatim | `tsconfig.json` (aliases `@/*`→`src/*`, `@/assets/*`), `eas.json` (4 profiles, `appVersionSource: remote`), `eslint.config.js`, `.vscode/*`, `__mocks__/expo-sqlite/kv-store.ts` | `../nmi-typhoon-watch/{tsconfig,eas}.json` |
| app.json | `typedRoutes` + `reactCompiler` on, `web.output: "server"`, portrait, `supportsTablet: false`, `userInterfaceStyle: "light"`, ids `com.27363.rootcause` / `com.tstst.rootcause`, scheme `rootcause`, Icon Composer `assets/expo.icon` | `../studyspace/app.json` |
| Layout | `src/app` (routes + `api/**/+api.ts`), `src/domain` (pure), `src/data` (kv/files repos + `.web.ts`), `src/services`, `src/store` (`appStore.ts` + `derived.ts`), `src/ui`, `assets/data`, `__tests__`, `docs` | both |
| State | `useSyncExternalStore` store; synchronous `hydrate()` at module scope in `_layout.tsx`; `actions` write to disk first | `../studyspace/src/store/appStore.ts` |
| Storage | `expo-sqlite/kv-store` with versioned keys (`name:v1`), `sanitize*` on read, full-disk guard that says what it dropped, `CacheMeta {fetchedAt, bytes, version}` | `../studyspace/src/data/{kv,repos}.ts` |
| Network | `fetch` + `AbortController` 10 s; services never throw; `refreshAll()` deduplicated; `refreshIfStale()` on foreground and reconnect | `../studyspace/src/services/{refresh,network}.ts` |
| Navigation | Root `Stack` `headerShown:false`, `Stack.Protected` onboarding gate, `unstable_settings.anchor='(tabs)'`, `Tabs` from `expo-router/js-tabs`, custom `BackHeader` + `goBackOr`, explainer modals, typed `router.push({pathname, params})` | `../studyspace/src/app/_layout.tsx`, `(tabs)/_layout.tsx` |
| UI | `theme.ts` tokens, `primitives.tsx` (`Screen`, `SectionHeader`, `Group`, `Cell`, `Callout`, `Button`, `Segmented`, `Toggle`, `Field`, `KeyValue`, `ProgressBar/Ring`), `icons.tsx` (SF Symbols + Ionicons fallback), no shadows, no spinners, 44 pt targets, body ≥ 15 pt, tabular numerals, English literals (no i18n layer) | `../studyspace/src/ui/*` (HEAD) |
| Backend | `+api.ts` route, zod-validated, injectable store for tests (`setStore()`), secrets only server-side, deploy via `expo export --platform web` + `eas deploy` | `../studyspace/src/app/api/crowd+api.ts` |
| AI | One route; output checked by code; manual path is the fallback | `../nmi-typhoon-watch/src/app/api/summarize+api.ts` (that route uses OpenRouter; this plan uses the Anthropic SDK directly — §3.6) |
| Weather | NWS client with required `User-Agent`, 10 s timeout | `../nmi-typhoon-watch/src/services/nwsClient.ts` |
| Docs | `CLAUDE.md` = `@AGENTS.md`; `AGENTS.md` = "Expo HAS CHANGED — read https://docs.expo.dev/versions/v57.0.0/" + sibling pointer; README section order; `docs/QA.md` (T-table, state matrix, demo script, deep links); `docs/<data>-sources.md` evidence trail | both |
| Tests | Domain unit tests; bundled-data integrity; route tests with `new Request()`; storage-guard; `screens.test.tsx` via `expo-router/testing-library` `renderRouter` asserting zero `fetch` offline in every demo scenario; `testID` on key controls | `../studyspace/__tests__/*` |
| Deviations by owner decision | Map SDK with online tiles (D2) instead of bundled SVG; accounts with OAuth (D3) instead of no accounts; Twilio SMS (D11); see §3 | — |
| Fix, don't copy | nmi's `StatusBar style="light"` on light bg; `userInterfaceStyle: "automatic"`; `.gitignore` missing `.env`; `ink2 === ink3`; the sibling in-memory rate-limit `Map` (fails on workerd, §3.10); the sibling `getStore()` silent memory fallback (must fail closed, §3.10) | nmi/StudySpace reports |

---

## 3. Key decisions

### 3.1 Backend shape — **B: Expo API routes as the only API, Supabase behind them**

| Option | Pros | Cons |
|---|---|---|
| A. Supabase-direct (phone uses supabase-js for data; logic in SQL/Edge Functions) | Least code to host; RLS gives roles; Realtime free | Score/state-machine logic split between SQL and TS; spec §10 REST surface (Open311, exports, ops queue) still needs HTTP routes; domain code not shared with the server |
| **B. Expo Router `+api.ts` routes (BFF) → Supabase with service key** | Sibling pattern scaled up (zod, injectable repos, `new Request()` tests); explicit `/v1` REST matching §10; `src/domain` runs on phone, console and server; secrets stay server-side; deploys with the web build | ~35 route files; workerd runtime constraints on EAS Hosting (R1): no in-memory state, short requests, no long jobs — solved by DB-backed limits, chunked jobs, pg_cron → HTTP |
| C. Separate Node service (Fastify/Nest + Postgres + Redis + BullMQ) — spec §5 literal | No runtime constraints; most faithful to §5 | Second deployable and toolchain; Redis/queue ops; not "like the others"; overkill for a single-city pilot |

Chosen **B**. Fallback if R1 bites: the same handlers behind the `@expo/server` Node/Express adapter (SDK 57 ships http, express, bun, vercel, netlify, workerd and eas adapters) on Fly.io/Railway.

### 3.2 Data platform — **Supabase Free plan (D7), two projects (preview, production)**
Spatial is "not optional" (§5): PostGIS covers duplicate search, bbox feeds, audience selection, block-group joins. Auth gives Apple / Google / email sign-in. Storage holds photos (private bucket, signed URLs). pg_cron + pg_net call `/api/jobs/tick` every minute (extension availability on Free verified in M0). Free-plan consequences, each with a mitigation: projects pause after 7 days without API activity → the 5-minute uptime check on `/api/health` performs a DB query and keeps both projects active, and the runbook covers un-pausing; no managed backups or PITR → our nightly `pg_dump` + Storage sync (§22) is the only backup; 500 MB database and 1 GB Storage → photos capped at ≤ 500 KB (1280 px, quality 0.7) plus a 320 px thumbnail, `/api/health` reports usage, and an upgrade is triggered at 70 % of either quota; 5 GB egress/month → thumbnails in lists, full image only on detail; 2 free projects per organisation → exactly preview + production. Alternative Neon + Clerk + R2 rejected: three vendors for the same result.

### 3.3 Map — **MapLibre + OpenStreetMap-based vector tiles (OpenFreeMap), native and web (D2)**
Native: `@maplibre/maplibre-react-native` (Expo config plugin; needs the dev client the siblings already use). Web console: `maplibre-gl` in `HazardMap.web.tsx`. Both consume the same style URL (`EXPO_PUBLIC_MAP_STYLE_URL`, default OpenFreeMap `liberty`; no key; attribution "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors" always visible) and the same GeoJSON source of reports with MapLibre's built-in clustering; circle colour = severity band, radius = vote count, cluster labels show counts; the peek card carries the text label so colour is never the only signal. Provider risk (OpenFreeMap has no SLA): the style URL is configuration, and the fallback is a self-hosted Protomaps PMTiles extract of the pilot area on Cloudflare R2 behind our own `style.json` — switching is an env change. Offline behaviour: §9.6. Deviation from the siblings' bundled SVG maps is deliberate (owner decision); the "zero API keys on the phone" rule still holds. `scripts/build-osm.ts` remains for exposure POIs/roads/address points (§8), not for rendering.

### 3.4 Identity — **sign-up required for all writes (D3); anonymous identity per report; capability matrix**
Supabase Auth with Sign in with Apple (`expo-apple-authentication` → `signInWithIdToken`), Google (`signInWithIdToken` with the Google iOS/Android/Web client IDs — configuration values, not secrets) and email one-time code (`signInWithOtp`, deep link `rootcause://auth/callback`). Apple's rule applies: offering Google means offering Apple. Browsing needs no account; reporting, voting, commenting, following, verifying and watch areas do. Sign-in is requested at the first server write, never in onboarding: online that is the photo upload after the shutter (before S-05), offline it is S-06 submit; drafts survive it. Providers per platform: iOS = Apple (native, nonce from `expo-crypto`) + Google (`@react-native-google-signin/google-signin`) + email code; Android = Google + email code; web console = email code + Google (§23.A, §23.E). Staff sign in by email (console or the app's settings screen so staff devices receive pages). `domain/roles.ts` defines `can(role, action)` for `resident | steward | inspector | supervisor | director | auditor`. First director via `scripts/grant-role.ts`; later via Admin › Users. Address verification to vote is **not** required (D3). **Anonymous identity:** a signed-in user may file a report as "Anonymous"; the server then stores `reporter_id = NULL`, NULL `uploader_id` on its photos, no reporter `report_follow`/`report_vote` rows, and the reporter's own vote as `report.reporter_vote_weight`; the device keeps a local link so "My reports" works and the client hides the vote control on such reports; such reports cannot receive status updates (spec R5 copy). An integration test asserts unlinkability (AC19). Spec §11's "submit report without account" row is a disclosed deviation (§20.1). Anonymous reports **do** carry vote weight for the score (D13).

### 3.5 Console — **same Expo codebase, web-only route group**
`src/app/console/*` renders only on web (native redirects home). Shares tokens, primitives, domain code and the API client; adds `DataTable`, `Sidebar`, `Kpi`, `Panel`, `Drawer`. Served by the same EAS Hosting deployment as the API. Rejected: separate Vite app (duplicate design system, second build).

### 3.6 AI — **one server route, Claude Haiku 4.5 via the official TypeScript SDK (D4), behind a flag, with a spend breaker**
Route `POST /api/v1/vision/analyze` (§7). Model `claude-haiku-4-5` (env `VISION_MODEL`); no `effort` parameter (not supported on Haiku 4.5) and no extended thinking (not needed for enum classification); `max_tokens` ≈ 600; structured output (`output_config.format`) constrained to taxonomy enums and validated with zod; request timeout 8 s after which S-05 proceeds without proposals; confidence floor 0.70 below which the UI says "unclear — pick a category"; hazardous taxa (hogweed, hemlock) never auto-confirmed; **no displacement/mm output** (spec §8 degrade rule; v1 has no calibration data). `report_photo.ai_json` stores the raw output and `model_version`. `VISION_DAILY_MAX` (default 500/day) trips the flag off for the day when exceeded. Every resident correction → `vision_feedback`. Cost at Haiku 4.5 rates ($1 / $5 per MTok): ≈ 2.5k input tokens per 1280 px photo plus a few hundred output tokens → about $0.003–0.005 per analysis; the breaker caps spend at about $2.50/day. `VISION_MODEL` is validated against the enum `['claude-haiku-4-5']` and the route fails closed on anything else; changing the model is a code change in `src/server/vision.ts` carrying a per-model request shape (Sonnet 5.5 would need `thinking: {type: 'between_tools'}` or adaptive thinking with `output_config.effort: 'low'`, `max_tokens` ≥ 4k, `stop_reason: 'refusal'` handling and `fallbacks: 'default'`) — the implementer must load the `claude-api` skill before writing or changing the route. The structured output also proposes a `severity_band` (1–3, never 4) with its own confidence; it is stored in `severity_ai` only at ≥ 0.70 and shown on S-05 as a proposal (§23.I). Deviation from nmi: direct Anthropic SDK instead of OpenRouter + fallback list.

### 3.7 Prediction — **rules + forecast + backlog, labelled as such**
`scenario.trigger_expr` JSON (spec §9 shape) evaluated against the latest NWS gridpoint forecast; `forecast.confidence` is NWS `probabilityOfPrecipitation` for rain scenarios and absent for wind/freeze; `asset.tag` conditions map to `report.storm_sensitivity`. Matching = open reports with matching tags; ranking = existing score; storm multiplier 1.0–1.6 applied to affected reports' stored scores when a `scenario_run` becomes `approved`, removed when it closes. Alert copy templated per hazard set (no LLM). Console labels the work list "rules-based: forecast × open backlog". The incident/recurrence model is Phase 2.

### 3.8 Design tokens — **sibling iOS grouped-list system; RootCause green as the one accent**
Spec tokens (lines 14–30): brand `#1f6b4f`, brand-2 `#2f8c66`, brand-soft `#e4f2ea`, blue `#2b5f9e`, amber `#b8791a`, red `#b23b30`. Adaptation (hex pinned):
- `palette.brand = '#1f6b4f'` (= `tint`; ≈ 6.4:1 on white), `brandFill = '#e4f2ea'`, `brandInk = '#0f3d2c'`; `#2f8c66` (≈ 4.1:1) is fill/icon only, never text.
- `red = '#B3261E'` (sibling), `amber = '#8A5A00'` (sibling; the spec's `#b8791a` is 3.6:1 and fails AA), `blue = '#2b5f9e'` (≈ 6.8:1), greys from the sibling palette.
- Semantic: red = critical / emergency / SLA breached; amber = high severity / at risk / stale; blue = storm/predictive context and moderate severity (spec badge mapping: Low grey, Moderate blue, High amber, Critical red); brand green doubles as "good/verified".
- Score chips: ≥ 85 red, ≥ 75 amber, ≥ 60 blue, else grey — a deviation from the prototype's green/mustard/orange/red `scoreChip` (line ~3159), to stay within the semantic set.
- Severity is never colour alone: `SeverityBars` (n of 4) + label, like StudySpace `LevelBars`; map pins get a text label in the peek card and cluster counts.
- Everything else verbatim from `../studyspace/src/ui/theme.ts`: iOS greys, `type` scale, `radius.group 12`, `GUTTER/CELL_PAD 16`, `MIN_TAP 44`, system fonts, `tabular`. Light only. Splash / adaptive icon / notification colour = `palette.brand`.
- Deviation: one extra semantic colour (`blue`) because the spec uses it for forecast context and the brand green cannot carry "information" and "good" at once.

### 3.9 Languages — **English only (D6)**
English only, through the tiny `t()` string table the siblings now ship (StudySpace HEAD `src/i18n`): one catalog `src/i18n/en.ts`, placeholders and plurals, no locale switching. Alert/push/SMS templates English. Spec §12's EN/ES/ZH/VI requirement is deferred (§20.1); a second catalog slots in without touching screens.

### 3.10 Runtime-safe server patterns (because EAS Hosting runs on workerd)
No in-memory state across requests: rate limits via a Postgres RPC (`rate_limit_hit(key, limit, window)` over a counters table) keyed primarily on user id (or IP when anonymous), with the client-generated `x-install-id` only as an additional dimension, never the sole key; jobs chunked and resumable (≤ 500 rows per call, cursor in `job_run`) because pg_net times out after 5 s; `getRepos()` fails closed with 503 when env is missing (no silent memory fallback outside tests); Twilio and Anthropic are called with `fetch`/SDKs that work on workerd (Twilio via its REST API with basic auth — the Twilio Node SDK is not assumed to run there).

### 3.11 Work orders — **RootCause owns the work order in v1, with a sync seam (D10)**
Spec open question 1 ("own or sync — needs a decision before the data model freezes", line 2539) and §14 Phase 1 ("Open311 + Cityworks sync", line 2504). The pilot has no Cityworks/Cartegraph sandbox or credentials, so v1 owns the record. The seam is built now: `src/server/sync/{types,noop}.ts` (`WorkOrderSync.onStatusChange/onCreate`, `external_id` column, vendor status-mapping table in `domain/status.ts`). Open311 GeoReport v2 **in and out** ships in M2/M3. Cityworks adapter is Phase 2.

### 3.12 SMS — **Twilio with one +1 number inside a Messaging Service (D11)**
`server/sms.ts` posts to the Twilio Messages REST API with `MessagingServiceSid` (the service holds the +1 number and handles STOP/HELP opt-out automatically); status callbacks land on `POST /api/webhooks/twilio` (signature validated) and update `alert_delivery`. Residents add a phone number in S-11 and verify it through **Twilio Verify** (exempt from 10DLC, so verification works from M2 regardless of campaign status; ≈ $0.05 + SMS per success); staff numbers are entered by the director in Admin › Users. **Compliance:** US A2P 10DLC brand + campaign registration (or toll-free verification) takes days to weeks and is submitted in M0 **after** its prerequisites exist (public `/privacy` and `/terms` pages with the SMS program language and a hosted opt-in mock — §23.H). Unregistered 10DLC / unverified toll-free traffic is **blocked outright** (Twilio 30034/30032), not filtered: until approval no SMS at all leaves our number, and push/email/inbox carry everything. Every first SMS to a number includes the sender name and "Reply STOP to opt out". Channel policy in §11. Voice calls remain deferred (§20.1).

---

## 4. Architecture

```
 Resident app (iOS/Android, Expo)         DPW console (web, same repo)
 ─────────────────────────────            ──────────────────────────────
 src/app/(tabs) …  ← src/ui, src/store,   src/app/console/* ← src/ui/console
 src/data (kv/files), src/services        src/services/apiClient (same)
 MapLibre RN (OpenFreeMap tiles)          maplibre-gl (same style URL)
        │ fetch + zod, bearer JWT                 │
        ▼                                         ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ Expo Router API routes  src/app/api/**/+api.ts  (EAS Hosting)    │
 │   auth: verify Supabase JWT → role/capabilities · zod · DB limits│
 │   src/server/* : repos (supabase-js, service key), photos, push, │
 │     sms (Twilio REST), email (Resend), nws, vision (Anthropic),  │
 │     sync seam, jobs, log                                         │
 │   imports src/domain/* (score, status, roles, audience, sla)     │
 └──────┬──────────┬──────────┬──────────┬──────────┬──────────┬────┘
        │          │          │          │          │          │
   Supabase     Supabase   Expo Push   Twilio     Resend    NWS api.weather.gov
   Postgres     Storage    (APNs/FCM)  (SMS)      (email)   Anthropic API (vision)
   +PostGIS · Auth (Apple/Google/email) · pg_cron → pg_net → /api/jobs/tick
```

**Request flows**
1. *Sign-in:* S-14 → Apple/Google native sheet → id token → `supabase.auth.signInWithIdToken` → session stored in kv (custom storage adapter) → `app_user` row created by a DB trigger on `auth.users` insert; email path: `signInWithOtp` → 6-digit code typed in app (deep link also accepted). The console uses email code or Google.
2. *Submit report (online):* capture → device resizes to ≤ 1280 px (≤ 500 KB) + 320 px thumbnail, re-encodes (EXIF dropped) → S-14 if signed out → `POST /v1/photos` (multipart; server re-strips EXIF with a pure-JS APP1 strip, checks MIME/size, stores both objects in the private bucket) → `{photoId}` → `POST /v1/vision/analyze {photoId, lat, lng}` (if flag on; ≤ 8 s) → proposals + duplicate candidates → form → sign-in if needed → `POST /v1/reports` (JSON: `clientDraftId`, `photoIds[]`, fields) → server snaps GPS to nearest address point/road from bundled data (labelled approximate), computes exposure proxy, computes score terms, writes `report` and `report_event`, records the reporter's own vote (a `report_vote` row for Named/Initials, `reporter_vote_weight` with no user row for Anonymous) and a reporter `report_follow` row unless Anonymous, runs duplicate RPC and sets `cluster_candidate` → returns `{report}`.
3. *Submit report (offline):* draft saved locally (`drafts:v1` + photo files) → form filled without proposals → when online the sync queue runs the upload then the create; replay with the same `clientDraftId` returns 200 with the original report (unique column).
4. *Add to existing report:* `POST /v1/reports/:id/photos {photoId}` attaches the photo (phase `before`) and records a vote; staff use the same route with phase `after` for completion evidence.
5. *Vote:* `POST /v1/reports/:id/votes` → PK (report_id, user_id) → weight from `votes.ts` → recompute community term and score → `vote_count` updated → threshold flags + supervisor push.
6. *Status change (console):* `PATCH /v1/reports/:id` → `status.transition()` validates (capability, from→to, after-photo required for `completed`) → `report_event` append → `WorkOrderSync.onStatusChange` (noop in v1) → push to reporter + followers (quiet hours unless emergency; SMS only for opted-in users without a device) → Open311 mapping applied on read.
7. *Emergency:* report with `emergency_requested` → `jobs/escalation` pages `on_call` (push + SMS + email) → `POST /v1/reports/:id/ack` → unacknowledged after 15 min → next in rota + director.
8. *Weather → scenario → alert (M4):* tick → `weather-poll` → forecast rows → `scenario.evaluate()` → `scenario_run` (proposed) → supervisor approves → storm multiplier applied → `POST /v1/alerts` draft → `POST /v1/alerts/:id/send` (now or scheduled) → `alert_delivery` rows per channel (§11 policy) → Twilio status callbacks update SMS rows → `post-event` job records outcome.

**Server/client boundary rule:** `src/server/**` is imported only from `src/app/api/**`. ESLint `no-restricted-imports` enforces it; `__tests__/boundary.test.ts` greps for violations and for secret-looking env names in client code.

---

## 5. Repository layout

```
rootcause/
├── app.json  eas.json  tsconfig.json  eslint.config.js  package.json  .env.example  .gitignore (+ .env)
├── AGENTS.md  CLAUDE.md (@AGENTS.md)  README.md  LICENSE
├── .claude/settings.json              # enable expo@claude-plugins-official (as nmi)
├── .github/workflows/ ci.yml  backup.yml
├── assets/
│   ├── data/ taxonomy.json  sla.json  remediation-options.json  wards.json  block-groups.json
│   │         osm/<pilot>.json (roads with class, address points, POIs — exposure + reverse-geocoding only)
│   │         demo/{reports,forecast-storm}.json
│   ├── expo.icon/  images/
├── docs/ QA.md  data-sources.md  taxonomy.md  privacy.md  terms.md  accessibility.md  perf.md  gap-analysis.md  runbook.md
├── scripts/ build-osm.ts  build-census.ts  seed-demo.ts  seed-synthetic.ts  perf-queue.ts  grant-role.ts  backup.sh
├── supabase/ config.toml  migrations/*.sql  seed.sql
├── __mocks__/ expo-sqlite/kv-store.ts  @maplibre/maplibre-react-native.tsx
├── __tests__/ domain/*  routes/*  screens.test.tsx  bundled-data.test.ts  storage-guard.test.ts  boundary.test.ts  public-projection.test.ts
└── src/
    ├── app/
    │   ├── _layout.tsx  +not-found.tsx  onboarding.tsx  sign-in.tsx  auth/callback.tsx  data.tsx  privacy.tsx  terms.tsx  settings.tsx  watch-areas.tsx  phone.tsx
    │   ├── (tabs)/ _layout.tsx  index.tsx  map.tsx  report.tsx (tabPress → modal)  alerts.tsx  me.tsx
    │   ├── report/ capture.tsx  analysis.tsx  form.tsx  submitted.tsx  [id].tsx
    │   ├── alert/[id].tsx   why/score/[id].tsx   why/index.tsx
    │   ├── r/[id].tsx  equity.tsx                 # public web pages
    │   ├── console/ _layout.tsx  index.tsx  overview.tsx  queue.tsx  orders/[id].tsx  map.tsx  equity.tsx
    │   │            scenarios.tsx  alerts.tsx  moderation.tsx  users.tsx  governance.tsx  settings.tsx  sign-in.tsx
    │   └── api/ health+api.ts
    │        v1/ photos+api.ts  reports+api.ts  reports/[id]+api.ts
    │            reports/[id]/{photos,votes,comments,verify,merge,follow,flag,ack}+api.ts  comments/[id]/flag+api.ts
    │            vision/{analyze,feedback}+api.ts   me+api.ts  me/{watch-areas,devices,reports,export,phone}+api.ts  me/phone/verify+api.ts
    │            ops/queue+api.ts  ops/analytics/[kind]+api.ts  ops/moderation+api.ts  ops/users+api.ts  ops/settings+api.ts
    │            scenarios+api.ts  scenarios/[id]/{run,worklist,dispatch}+api.ts
    │            alerts+api.ts  alerts/[id]/{send,deliveries}+api.ts  export/[kind]+api.ts
    │        open311/v2/ services.json+api.ts  requests.json+api.ts  requests/[id]+api.ts   # a dot inside a static segment is fine; only [x] must be a whole segment; strip ".json" from the id param
    │        webhooks/twilio+api.ts
    │        jobs/tick+api.ts
    ├── domain/  types.ts  taxonomy.ts  score.ts  status.ts  roles.ts  votes.ts  audience.ts  scenario.ts  sla.ts  moderation.ts  channels.ts  geo.ts  time.ts  ids.ts  demo.ts
    ├── data/    kv.ts  kv.web.ts  files.ts  files.web.ts  repos.ts (drafts, mutations, cache, prefs, watchAreas, session, mapPack)
    ├── services/ apiClient.ts  auth.ts  photos.ts  syncQueue.ts  refresh.ts  network.ts  location.ts  camera.ts
    │             notifications.ts  mapOffline.ts  demo.ts
    ├── server/  db.ts  auth.ts  ratelimit.ts  photos.ts  exif.ts  public.ts (toPublicReport)  push.ts  sms.ts  email.ts  nws.ts  vision.ts
    │            repos/{reports,votes,users,alerts,forecast,moderation}.ts  repos/memory/*.ts
    │            sync/{types,noop}.ts  jobs/{tick,weatherPoll,recompute,autoVerify,coarsenGps,purgePhotos,escalation,alertDispatch,pushReceipts,postEvent}.ts  log.ts  sentry.ts
    ├── store/   appStore.ts  derived.ts
    └── ui/      theme.ts  primitives.tsx  Screen.tsx  icons.tsx  severity-widgets.tsx  score-widgets.tsx
                 HazardMap.tsx  HazardMap.web.tsx  report-widgets.tsx  console/{Sidebar,Kpi,Panel,DataTable,Drawer}.tsx
```

Expo Router's server manifest matches static segments character for character and treats only a whole `[x]` segment as dynamic, so the Open311 collection routes are named `services.json+api.ts` and `requests.json+api.ts` (a dot inside a static segment is allowed); `requests/[id]+api.ts` strips a trailing `.json` from the id. Because `new Request()` route tests call handlers directly, an export smoke test (`expo export --platform web`, serve `dist`, request the literal `.json` URLs) guards the routing (§14).

Files copied from `../nmi-typhoon-watch` then edited: `tsconfig.json`, `eas.json`, `eslint.config.js`, `.vscode/*`, `__mocks__/expo-sqlite/kv-store.ts`, `src/data/{kv,kv.web,files,files.web}.ts` (`SQLiteStorage('rootcause')`, web prefix `rootcause:`), `src/services/{network,location}.ts` (fix the typhoon comment), `src/app/_layout.tsx`, `(tabs)/_layout.tsx`. From `../studyspace` HEAD: `src/ui/{theme,primitives,Screen,icons}.tsx` (includes `Field`; palette per §3.8).

---

## 6. Data model v1 (SQL migrations, PostGIS)

Subset of spec §6 (line 2288). Column names follow the spec where the concept exists; renames and additions are listed after the table.

| Table | Key columns | Notes |
|---|---|---|
| `tenant` | id, slug, name, score_weights jsonb, community_k numeric (0.25), active_users_floor int (20), storm_multiplier_max (1.6), injury_notify_emails text[], vision_daily_max int, sms_enabled bool | one row `pilot`; every table carries `tenant_id` (§5 multi-tenancy later) |
| `app_user` | id (= auth.uid), tenant_id, role enum, display_name, auth_provider enum(apple/google/email), home_geom geography(Point) NULL, block_group_id, verified_resident bool, trust_score (1.0), phone_e164 NULL, phone_verified_at, sms_opt_in bool, quiet_hours jsonb, blocked_by uuid[], created_at | `home_geom` and `phone_e164` never leave the server; row created by trigger on `auth.users` |
| `sms_message` | sid PK, tenant_id, kind enum(otp/status/page/alert), user_id NULL, to_last4, status enum(queued/sent/delivered/undelivered/failed), error_code, created_at, updated_at | every SMS we send (claim row written before the Twilio call; §23.H); phone verification itself uses Twilio Verify, so there is no OTP table |
| `device` | id, user_id, expo_push_token, platform, install_id, last_seen_at | push targets (residents and staff) |
| `on_call` | id, tenant_id, user_id, starts_at, ends_at, order_no | rota for emergency paging |
| `report` | id, tenant_id, client_draft_id UNIQUE, reporter_id NULL, reporter_display enum, category, subtype, status enum(8), severity_resident NULL, severity_ai NULL, severity_confirmed NULL, emergency_requested bool, emergency_ack_at, emergency_ack_by, injury_flag enum(no/near_miss/injury), ada_flag, storm_sensitivity text[], geom geography(Point), geom_public geography(Point), address_text, address_confidence enum(exact/approx), ward_id, block_group_id, exposure_terms jsonb, score numeric, score_terms jsonb, vote_count int, reporter_vote_weight numeric, cluster_id, cluster_candidate uuid NULL, external_id, flags jsonb (supervisor_review, council_item, suspicious), created_at, first_ack_at, assessed_at, mitigated_at, scheduled_for, completed_at, verified_at, closed_at | indexes: GIST(geom), GIST(geom_public); (tenant_id, status, score DESC); (tenant_id, emergency_requested) partial; partial on status IN ('new','triaged'); BRIN(created_at) |
| `report_photo` | id, report_id NULL (pending until attached), uploader_id NULL (always NULL once attached to an anonymous report), storage_key, thumb_key, phase enum(before/after), width, height, bytes, captured_at, faces_blurred bool (false in v1), visibility enum(staff_only/public), ai_json jsonb, model_version, created_at | private bucket; EXIF stripped; public only after staff release at triage |
| `report_vote` | PK(report_id,user_id), weight, block_group_id, unverified_geo bool, install_id, created_at | |
| `report_comment` | id, report_id, user_id, body, is_staff, is_internal bool, hidden bool, created_at | internal = labelled "still subject to records requests" |
| `report_event` | id, report_id, actor_type, actor_id, from_status, to_status, kind, note, created_at | **append-only (trigger raises on UPDATE/DELETE)** |
| `report_follow` | PK(report_id,user_id) | voters auto-follow |
| `verification` | id, report_id, user_id, verdict enum(confirmed/rejected), photo_id NULL, created_at | |
| `content_flag` | id, target_type enum(report/comment/photo), target_id, reporter_id, reason, status enum(open/actioned/dismissed), created_at | moderation queue |
| `severity_audit` | id, report_id, ai_value, human_value, inspector_id, reason, created_at | append-only |
| `vision_feedback` | id, report_id NULL, photo_id, proposed jsonb, corrected jsonb, user_id, model_version, created_at | label store |
| `watch_area` | id, user_id, kind enum(home/work/route/custom), geom geography, radius_m, categories text[], schedule jsonb | never exposed to other users |
| `block_group` | geoid, tenant_id, ward_id, geom, population, median_hh_income | Census TIGER + ACS, loaded by `build-census.ts` |
| `block_group_stats` | geoid, computed_at, active_users, reports_per_1k, median_days_to_close, open_hazard_index, reporting_pct, index_pct, gap | nightly |
| `weather_forecast` | id, issued_at, valid_from, valid_to, grid_id, rain_mm, pop_pct, gust_kmh, temp_min, temp_max, payload jsonb | NWS gridpoint |
| `scenario` | id, tenant_id, name, kind enum(rain/wind/freeze), trigger_expr jsonb, action_thresholds jsonb, storm_multiplier numeric, enabled | §9 shape |
| `scenario_run` | id, scenario_id, forecast_id, triggered_at, worklist jsonb, audience_count, status enum(proposed/approved/dispatched/closed), outcome jsonb | post-event outcome lives here |
| `alert` | id, tenant_id, scenario_run_id NULL, severity enum(advisory/warning/emergency), channel_mix jsonb, audience_query jsonb, hazard_ids uuid[], forecast_snapshot jsonb, body_i18n jsonb, approved_by, scheduled_for, sent_at | content-addressed per spec O11 dev note |
| `alert_delivery` | alert_id, user_id, channel enum(push/sms/email/inbox), status enum(queued/sent/delivered/failed/undelivered), provider_id, sent_at, opened_at, action_taken, error | fatigue budget = push+sms rows per user per 7 d; `provider_id` = Twilio Message SID |
| `rate_limit_counter` | key, window_start, count | used by `rate_limit_hit()` RPC |
| `job_run` | name, started_at, finished_at, ok, cursor jsonb, error, last_ok_at | drives `/api/jobs/tick` and `/api/health` |
| `sla_config` | tenant_id, severity_band, ack, assess, mitigate, fix (intervals) | seeded from O10 table; numeric values for the prose cells: Next cycle = 90 d, 1 season = 120 d, Bundled = 365 d |
| `remediation_option` | id, category, name, unit_cost, expected_recurrence_months, tree_outcome | reference table, read-only in O3 |
| `audit_log` | id, actor_id, action, target, diff jsonb, created_at | staff writes; append-only |

**Renames/additions vs spec §6:** `s3_key → storage_key`; `exif_gps` dropped (EXIF stripped; `geom` is the report's location); `report.client_draft_id`, `geom_public`, `vote_count`, `reporter_vote_weight`, `emergency_*`, `cluster_candidate`, `address_confidence`, `report_photo.thumb_key/visibility/model_version`, `app_user.phone_*`/`sms_opt_in`/`auth_provider`, `phone_otp`, `content_flag`, `on_call`, `rate_limit_counter`, `job_run`, `alert_delivery.status/provider_id` added. Phase-2 tables (tree, species, sidewalk_segment, drain, risk_score, incident, crew, assignment, bundle, sensitivity) are not created in v1.

**RLS:** enabled on every table; API routes use the service role; no client-direct table access (the phone uploads photos through the API). **SQL functions (rpc):** `find_duplicates(lat,lng,category)` (25 m point / 60 m linear subtypes), `reports_in_bbox(...)`, `audience_for_hazards(hazard_ids, buffer_m)`, `rollup_block_groups()`, `rate_limit_hit(key, limit, window)`. **Enums** come from `assets/data/taxonomy.json` and a test checks them against the migration.

**Definitions:** `open_hazard_index` = percentile rank (0–100) across the tenant's block groups of Σ score of open reports per 1k residents — labelled "what has been reported, weighted by score — not a prediction"; `gap` = `index_pct − reporting_pct` (spec O10 definition).

---

## 7. API surface v1 (Expo Router routes)

All JSON unless noted; auth = Supabase JWT bearer; capabilities from `domain/roles.ts` (`anon` = no token). Every write requires a signed-in account (D3). Rate limits are enforced by the `rate_limit_hit` RPC, keyed primarily on user id (or IP when anonymous); the client-generated `x-install-id` is an additional dimension, never the only key.

| Route | Capability | Limit | Purpose |
|---|---|---|---|
| `GET /api/health` | anon | — | version, db reachability (also the Free-plan keep-alive), forecast age, `jobs: {name: last_ok_at}`, storage/db usage % |
| `POST /api/v1/photos` (multipart ≤ 600 KB JPEG + thumbnail) | resident | 20/h | strip EXIF server-side, store, `{photoId}`; pending until attached; unattached photos purged after 24 h |
| `POST /api/v1/vision/analyze` | resident | 20/d, tenant daily max | flag; `{photoId, lat, lng}` → proposals + duplicate candidates |
| `POST /api/v1/vision/feedback` | resident | | correction label |
| `POST /api/v1/reports` | resident | 10/h, 30/d | JSON `{clientDraftId, photoIds[], …}`; replay → 200 original body |
| `GET /api/v1/reports?bbox&cat&status&sort&cursor` | anon | 600/min IP | public feed/map through `toPublicReport()`; GeoJSON when `Accept: application/geo+json` (map source) |
| `GET /api/v1/reports/:id` | anon | | public projection; staff get full projection |
| `PATCH /api/v1/reports/:id` | inspector (status/severity/mitigation), supervisor (schedule) | | validated by `domain/status` |
| `POST /api/v1/reports/:id/photos` | resident (`before`, counts as vote) / inspector (`after`) | 20/h | attach |
| `POST/DELETE /api/v1/reports/:id/votes` | resident | 60/h | one per account; geo check; weight |
| `POST /api/v1/reports/:id/comments` | resident / staff | 20/h | `is_internal` staff only; `domain/moderation` filter |
| `POST /api/v1/reports/:id/verify` | reporter or follower | | confirm/reject with optional photo |
| `POST /api/v1/reports/:id/merge` | inspector | | merge cluster: photos + votes move, events written |
| `POST/DELETE /api/v1/reports/:id/follow` | resident | | |
| `POST /api/v1/reports/:id/flag`, `POST /api/v1/comments/:id/flag` | resident | 10/d | moderation queue |
| `POST /api/v1/reports/:id/ack` | supervisor | | emergency acknowledgement |
| `GET/PATCH/DELETE /api/v1/me` | resident | | profile, quiet hours, sms opt-in, impact stats; DELETE = de-identify + delete auth user + sign-out |
| `POST /api/v1/me/phone` (start), `POST /api/v1/me/phone/verify` (check) | resident | 3/h per user, 3/h and 10/d per number | Twilio Verify (exempt from 10DLC, works before campaign approval); stores `phone_e164` + `phone_verified_at` |
| `POST /api/v1/me/apple-link` | resident (iOS) | | exchanges the Apple `authorizationCode` within 5 min of sign-in for a refresh token (needed to revoke on account deletion; §23.C) |
| `GET /api/v1/config` | anon | | map style URL (bundled default vs self-hosted fallback), feature flags; cached by the app |
| `GET/POST/DELETE /api/v1/me/watch-areas`, `POST /api/v1/me/devices`, `GET /api/v1/me/reports`, `GET /api/v1/me/export` (2/d) | resident | | |
| `GET /api/v1/ops/queue?ward&cat&status&storm&q&sort&cursor` | inspector | | keyset-paginated; emergencies first; p95 < 400 ms |
| `GET /api/v1/ops/analytics/{equity,sla,backlog}` | inspector (equity also public read via `/equity`) | | SLA state computed at read time |
| `GET/PATCH /api/v1/ops/moderation`, `GET/PATCH /api/v1/ops/users` (roles, phones, rota), `GET/PATCH /api/v1/ops/settings` | supervisor / director / director | | audited |
| `GET/POST /api/v1/scenarios`, `POST /:id/run`, `GET /:id/worklist`, `POST /:id/dispatch` | supervisor (director to create) | | M4 |
| `GET/POST /api/v1/alerts`, `POST /:id/send`, `GET /:id/deliveries` | supervisor (`emergency`: director) | | M4 |
| `GET /api/v1/export/reports.{csv,geojson}` | auditor/staff; public projection for others | | |
| `GET /api/open311/v2/services.json`, `requests.json`, `requests/:id.json`; `POST requests.json` (api_key) | anon read; api_key write | | GeoReport v2 in and out |
| `POST /api/webhooks/twilio` | Twilio signature | | delivery status → `alert_delivery` |
| `POST /api/jobs/tick` | `x-job-secret` | | runs due jobs' next chunk; returns within 5 s |

Validation: zod schemas in `src/domain/types.ts` shared with the client. Errors: `{error: {code, message}}`; 400 invalid, 401 no session, 403 capability, 404, 409 duplicate vote, 422 invalid transition, 429 limit (with `Retry-After`), 503 misconfigured.

---

## 8. Domain modules (pure TypeScript, no RN/Expo imports)

| Module | Contents | Spec |
|---|---|---|
| `taxonomy.ts` | categories/sub-types, sensitivity tags, ADA relevance, linear-feature flag (60 m dup radius), resident wording | R5 form (line 739), mock data |
| `score.ts` | `WEIGHTS {severity .32, exposure .24, community .22, liability .14, decay .08}`; `SEVERITY_BAND {1:.25, 2:.5, 3:.78, 4:1}`; `effectiveSeverity = confirmed ?? ai ?? (resident != null ? min(resident, 3) : 2)` — band 4 only after human confirmation; band 2 labelled "unrated — awaiting triage" for intake paths with no resident answer (Open311 inbound, inspection tasks); `exposureTerm(peds, flags)` = `min(1, log1p(peds)/log1p(5000)) × vulnMult`, `vulnMult = 1 + .15 school + .15 senior + .10 transit + .10 adaRoute (0 in v1), cap 1.4`; `communityTerm(Σw, max(activeUsers, floor), k)` = `min(1, log1p(Σw)/log1p(k × N))`; `liabilityTerm = max(ada×.9, injury×1.0, nearMiss×.5, priorNoticeDays>90 ? .7 : 0)` (near-miss weight is a pilot default — spec gives none); `decayTerm = min(1, daysOpen/365)`; `score = 100 × Σ(w·term) × stormMultiplier`; `explain()` labels | §7 (2346–2363) |
| `status.ts` | 8 statuses, `transition(from, to, actor, ctx)` with capability + evidence rules, resident wording, Open311 + vendor mapping tables | status table (~2101), §4.4 |
| `roles.ts` | `can(role, action)` capability matrix | §11 (2464) |
| `votes.ts` | thresholds 25/100, geo rule 1.5 km, `weight(account)` 0.6/1.0, anomaly flags (velocity per install, same install many accounts, distance) | §4.3, E6 |
| `audience.ts` | pure predicate: category match, schedule, fatigue (< 2 push+sms per 7 d, emergency exempt), quiet hours unless emergency | §9 |
| `channels.ts` | channel policy per alert severity and user state (device? phone verified + opt-in? quiet hours?) → ordered channel list; every template names a place and an action | §9, §12 |
| `scenario.ts` | `evaluate(triggerExpr, forecast, openReports)` → matched hazards + work list; multiplier | §9 |
| `sla.ts` | bands → ack/assess/mitigate/fix; `slaState(report, config, now)` | O10 table |
| `moderation.ts` | comment filter (word list, length, links), block visibility rule | App Store 1.2 |
| `geo.ts` | haversine, bbox, 50 m grid snap, deterministic jitter | sibling `geo.ts` |
| `time.ts` | Intl in `America/New_York`, `nowMs()` with demo offset | sibling |
| `demo.ts` | `calm` / `storm` / `verify` definitions, deterministic seeds | sibling |

Oracles for tests are derived from the formula, not the prototype (the spec calls prototype figures placeholders, line 2567). Worked example: terms .78/.82/.12/.90/.04 → `100 × (.2496 + .1968 + .0264 + .126 + .0032) = 60.2 → 60`. Every constant carries a `// spec:` comment; `/why/score/[id]` renders them.

**Exposure data (v1, labelled "estimated from map data"):** `scripts/build-osm.ts` pulls OSM via Overpass at build time for the pilot bbox: roads with `highway` class → pedestrians/day lookup (primary 4000, secondary 2500, tertiary 1500, residential 600, living_street 400, footway/pedestrian 1200, path 200, service 150; motorway/trunk 0), POIs within 200 m: schools (`amenity=school`), senior facilities (`social_facility=nursing_home|assisted_living`), transit stops (`highway=bus_stop`, `railway=station|tram_stop`), address points (`addr:housenumber`) for approximate reverse-geocoding. Replace with city pedestrian counts when the pilot provides them (`docs/data-sources.md`).

---

## 9. Resident app

### 9.1 Tabs and routes
Five tabs via `expo-router/js-tabs`: **Home** (S-01), **Map** (S-02), **Report** (centre; `tabPress` intercepted → `/report/capture` as a full-screen modal stack — one tap to camera, spec 4.1), **Alerts** (S-03), **Me** (S-10). Plain tab styling (no raised circle — iOS idiom).

| App ID | Route | Spec | Notes |
|---|---|---|---|
| S-00 | `/onboarding` | — | Home watch area (map tap or "use my location"), categories, quiet hours; no sign-in here; notification permission asked later on first follow/vote |
| S-01 | `/` | R1 | Hero = active scenario advisory (M4) or neighbourhood index card; feed sort (urgency/distance/newest), category chips; barometer |
| S-02 | `/map` | R2 | `HazardMap` (MapLibre), filter chips, peek card, "Report what I see here" |
| S-03 | `/alerts` | R8 | Chips: All / Storm / My reports |
| S-04 | `/report/capture` | R3 | `expo-camera` `CameraView` or library; guidance per category; resized to ≤ 1280 px / ≤ 500 KB + 320 px thumbnail, re-encoded; saved to `Paths.document/drafts/`; library photos require confirming the location on the map |
| S-05 | `/report/analysis` | R4 | Shows exactly the image that uploads; proposals (if online + flag) with confidence or "unclear"; duplicate candidates; offline → "Analysis runs when you're back online; you can still file now" |
| S-06 | `/report/form` | R5 | Segmented category, sub-type, danger (4), hurt (3), location text (approximate, editable), note, identity; 911 line when Emergency; Submit → S-14 if signed out → submit; Save draft |
| S-07 | `/report/submitted` | R6 | Score + five bars, rank, SLA timeline, share; offline StatusLine |
| S-08 | `/report/[id]` | R7 | Photos (public ones), badges, vote meter (n of 25), score card → `/why/score/[id]`, AI read, timeline, comments, nearby, follow, flag |
| S-09 | `/alert/[id]` | R9 | M4 briefing |
| S-10 | `/me` | R13 | Impact stats, my reports (server + local-only anonymous), settings, privacy, export, delete my data; signed-out state shows "Sign in to vote and follow" |
| S-11 | `/settings`, `/watch-areas`, `/phone` | R14 | Watch areas CRUD, triggers, quiet hours, phone number + SMS opt-in with code verification, staff sign-in |
| S-12 | `/data` | sibling S-09 | Cache status, "Simulate no signal", demo picker, failed drafts with reasons, **offline map pack download/remove (size shown)**, reset |
| S-13 | `/privacy`, `/terms` | §13 | Photo handling, what is shared, retention (reports and photos kept 7 years as public records; "delete my data" de-identifies), SMS terms, no sharing with enforcement agencies, contact |
| S-14 | `/sign-in`, `/auth/callback` | — | Apple, Google, email code; explains why ("one vote per person; your reports stay yours"); returns to where it was opened |
| — | `/why/score/[id]`, `/why/index` | §7 | Modals rendering constants |

### 9.2 Offline-first intake and mutations
- `draftsRepo` (`drafts:v1`): `{id, photoUris[], gps, locationConfirmed, capturedAt, form, status: draft|queued|uploading|sent|failed|needs_sign_in, failReason}`. Disk before state.
- `mutationsRepo` (`mutations:v1`): ordered queue of `{vote|unvote|comment|follow|unfollow|verify}` with optimistic UI and server reconciliation; requires a session (the UI asks to sign in before queuing).
- `syncQueue.flush()` on reconnect, foreground, after submit and after sign-in; sequential; per draft: upload photos → create report (`clientDraftId`) → mark `sent`. Retry policy: retry on network error, 408, 429 (`Retry-After`), 5xx, and 401 after a token refresh (if refresh fails → `needs_sign_in`, shown in S-10/S-12); fail (shown with the reason, never silently dropped) on 400/403/422.
- Optional `expo-background-task` flush (sibling `backgroundPoll.ts` pattern) — best effort, dev/prod builds only.
- Feed/map cache: `cache:feed:v1` keyed by home bbox (GeoJSON), `CacheMeta`, 5-min staleness, StatusLine "Reports saved 12 min ago · no signal".

### 9.3 Identity & auth on the phone
`services/auth.ts` wraps supabase-js (auth only; storage adapter over kv-store): `signInWithApple()`, `signInWithGoogle()`, `sendEmailCode(email)` / `verifyEmailCode()`, `signOut()`, `requireSession(reason)` which opens S-14 and resolves after sign-in. No anonymous sessions. Supabase Auth's built-in rate limits stay on; a Turnstile challenge (WebView widget) ships in the build behind a flag that is off by default for the email path. "Delete my data" → `DELETE /me` (de-identify + delete auth user) → sign out (App Store account-deletion requirement).

### 9.4 Notifications and SMS
`expo-notifications`: token registered via `/me/devices` after first follow/vote/report. Channels `rootcause-status` and `rootcause-alerts` (M4, high importance), `rootcause-paging` for staff. Payload `{reportId}` / `{alertId}` deep links. SMS: opt-in in S-11 after code verification; residents receive SMS only for `warning`/`emergency` alerts and status changes when they have no registered device; staff receive paging SMS always.

### 9.5 Demo scenarios
`rootcause://?demo=calm|storm|verify`, `rootcause://report/<id>`, `rootcause://map?cat=vegetation`. `storm` loads an archived NWS forecast shifted to tonight and demo-labelled reports; `verify` puts one report in `completed` awaiting confirmation. Device-time facts use `useRealNow`. Demo mode works signed-out (reads only) and signed-in.

### 9.6 Map offline behaviour
Pins come from the locally cached GeoJSON (`cache:feed:v1`) and render with or without tiles. Tiles: MapLibre's ambient cache keeps recently viewed tiles; `services/mapOffline.ts` offers an optional offline pack for the pilot bbox (zoom 11–15) downloaded over Wi-Fi from S-12, with the measured size shown before download (estimated in M1; must be < 150 MB or the zoom range shrinks). Without tiles the map shows a plain background, the pins, and a StatusLine "Map tiles unavailable offline · showing saved reports". Attribution stays visible in all states.

---

## 10. Console (web)

Route group `src/app/console/`, guard: web only + staff capability; `sign-in.tsx` (email code or Google). Sidebar groups as in the prototype (Operate / Predict / Decide / Admin); Phase-2 items shown disabled with "Phase 2".

| View | Route | Key interactions |
|---|---|---|
| Overview (O1) | `/console/overview` | KPIs, "needs a decision today" (emergencies pinned with ack timer), intake mix, backlog age; ward + period filters; CSV export |
| Triage queue (O2) | `/console/queue` | `DataTable` sort (score/votes/age/exposure), filters (category/status/storm), search; keyboard (↑↓ open, Esc close); duplicate clusters panel with Merge |
| Work order (O3) | `/console/orders/[id]` (modal over queue) | Evidence (release photos to public), five bars via `explain()`, status actions constrained by `status.ts`, confirm/override severity (reason → `severity_audit`), log mitigation, remediation option, resident update vs internal note, acknowledge emergency, order history |
| Map (O4) | `/console/map` | `HazardMap.web` large; layers; hot blocks; silent zones with "Schedule inspection" (creates a staff-originated inspection task report) |
| Equity & SLA (O10) | `/console/equity` (+ public `/equity`) | Block-group/ward table with gap; SLA performance; correction-mechanics text |
| Scenarios (O6) | `/console/scenarios` | M4 |
| Alert composer (O11) | `/console/alerts` | M4: channel picker (push / push+SMS / all), recipient counts per channel, SMS segment count and cost preview, test send, schedule, send; history with sent/delivered/failed per channel |
| Moderation | `/console/moderation` | Flag queue: hide/restore photo or comment, block account, dismiss; all audited |
| Admin › Users | `/console/users` | Director: grant/revoke roles, staff phone numbers, on-call rota |
| Governance (O12) | `/console/governance` | Static page |
| Settings | `/console/settings` | Director: weights (sum 1.00 enforced), SLA config, scenario thresholds, vision daily max, SMS enabled; every change → `audit_log` |

Components: `src/ui/console/{Sidebar,Kpi,Panel,DataTable,Drawer}.tsx` on RN primitives; same tokens; min width 1024 px; visible focus rings.

---

## 11. Jobs, channels and integrations

One pg_cron entry (every minute) → pg_net POST `/api/jobs/tick` (5 s budget) → `jobs/tick.ts` reads `job_run`, runs the next chunk of each due job (≤ 500 rows), persists cursor, returns. `/api/health` exposes `last_ok_at` per job; the uptime monitor alerts when any job is stale beyond its interval × 3.

| Job | Interval | Work |
|---|---|---|
| `weatherPoll` | 15 min | NWS gridpoint fetch (QPF, PoP, gusts, temps) with `User-Agent`; staleness badge when > 60 min |
| `escalation` | 1 min | emergencies unacknowledged > 15 min → re-page next on-call + director (push + SMS + email) |
| `alertDispatch` | 1 min | send scheduled alerts per channel policy; SMS via Twilio with status callback URL |
| `pushReceipts` | 15 min | Expo receipts; drop invalid tokens |
| `recompute` | nightly 02:00 | decay term, `block_group_stats` (incl. `active_users`), vote anomaly flags, scenario multipliers |
| `autoVerify` | nightly | completed > 14 d without verdict → verified (event "auto-verified after 14 days") |
| `coarsenGps` | nightly | anonymous reports > 30 d: `geom` := 50 m snap (raw GPS nulled), `address_text` kept |
| `purgePhotos` | nightly | unattached photos > 24 h deleted; expired `phone_otp` rows deleted |
| `postEvent` | 6 h after onset (M4) | records outcome per scenario run |

**Channel policy (`domain/channels.ts`):**

| Message | Push (device) | SMS (verified + opt-in) | Email | Inbox |
|---|---|---|---|---|
| Status change on own/followed report | yes | only if no device | no | yes |
| Predictive advisory (M4) | yes | no | no | yes |
| Predictive warning (M4) | yes | yes | no | yes |
| Emergency alert (M4, director) | yes, breaks quiet hours | yes | yes if known | yes |
| Staff paging / escalation | yes | yes | yes | — |

Fatigue budget counts push + SMS rows; quiet hours suppress everything except emergency; each SMS is one segment where possible (≤ 160 GSM-7 characters; the composer shows segment count).

Integrations: Expo push (`expo-server-sdk`), Twilio Messages REST API + status webhook (signature validation; STOP/HELP handled by the Messaging Service), Resend email, NWS, Open311 in/out, exports (CSV/GeoJSON), `WorkOrderSync` seam (noop). Fallback scheduler: GitHub Actions `schedule` hitting `/api/jobs/tick` if pg_net is unavailable.

---

## 12. Security, privacy, retention

- **Secrets:** server env only (`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `TWILIO_AUTH_TOKEN`, `RESEND_API_KEY`, `JOB_SECRET`); `.env`, `.env*.local` gitignored; production via `eas env:set --visibility sensitive`; preview and production use different Supabase projects, Twilio Messaging Services and keys. OAuth client IDs and the Supabase publishable key are public configuration.
- **Auth/authz:** Supabase JWT verified (JWKS cached); capability matrix per route; a route × role test table asserts expected status codes; `auditor` writes rejected everywhere; every write without a session → 401 (AC22).
- **Public projection:** every non-staff view (`/v1/reports`, `/r/[id]`, Open311, exports) goes through `server/public.ts` `toPublicReport()` with an allow-list test. It emits `geom_public` (reporter-linked reports: deterministic 50 m snap/jitter computed at insert — spec §13 "public map jitters reporter-linked points"; anonymous reports: precise until day 30, then the stored `geom` itself is coarsened — spec §12), reporter display per identity choice, no internal notes, no `home_geom`, no watch areas, no phone, no `install_id`.
- **Anonymous unlinkability:** anonymous reports have no `reporter_id`, no `uploader_id` on their photos, and no reporter follow/vote rows (§3.4); verified by an integration test (AC19). Rate-limit counters are keyed by hashed user id in hourly windows and hold no report ids.
- **Photos:** private bucket, signed URLs (1 h) server-side; EXIF stripped on device and server; `visibility = staff_only` until an inspector releases at triage (compensates for no face/plate blur in v1); staff hide; resident flag; takedown path in `/privacy`. Phase 2: on-device blur (`faces_blurred` column ready).
- **Phone numbers:** stored E.164, never exposed; OTP codes hashed; SMS copy never includes report free text from other users; Twilio webhook signature validated; STOP honoured by the Messaging Service and mirrored to `sms_opt_in = false` on the `undelivered`/opt-out callback.
- **Deletion vs retention:** `DELETE /me` de-identifies (reporter_id → NULL, display → anonymous, comments attributed to "former user", devices/phone/watch areas/votes' identity removed) and deletes the auth user; reports, photos and events stay 7 years as public records (§12). S-13 says so plainly.
- **Abuse:** DB-backed rate limits (user + IP + install), one vote/account, new-account down-weight, per-capita normalisation with floor, saturation, 22 % cap, anomaly flags → `suspicious` (weight 0.5, staff review), emergency 1/day/account, vision daily breaker, OTP send/attempt limits, comment filter, blocks; OAuth accounts cost more to farm than anonymous sessions did.
- **Append-only:** `report_event`, `severity_audit`, `audit_log` by DB triggers (integration test: UPDATE raises).
- **Records law:** internal notes labelled in UI and schema; exports from day one.
- **Health data:** none in v1.
- **Logging/monitoring:** structured logs without PII (phone numbers masked); Sentry (app + routes) with PII scrubbing (D9); uptime checks on `/api/health`.

---

## 13. Design system adaptation (summary)

- `theme.ts`: palette per §3.8; `toneColor = {brand, blue, amber, red}`; `severityTone = {1: 'grey', 2: 'blue', 3: 'amber', 4: 'red'}`; score chip thresholds ≥ 85 red, ≥ 75 amber, ≥ 60 blue.
- New widgets: `SeverityBars`, `SeverityBadge`, `ScoreBreakdown` (five `ProgressBar`s + labels, shared with console), `VoteControl` (▲ count, voted state, 44 pt), `StatusTimeline`, `HazardMap` (+ `.web`) with `MapLegend` and attribution, `ScenarioCard` (blue rain, amber wind/freeze; red only for emergency), `SignInSheet`.
- Copy: plain English, sentence case, concrete local facts; every alert and SMS names a place and an action (§9).
- Accessibility: header roles; `VoteControl` label "Urgency vote, 41 residents, you voted"; `SeverityBars` reads "High, 3 of 4"; map pins are mirrored by the list below the map for screen-reader users; live regions on StatusLine; `maxFontSizeMultiplier` 2.0 on body/detail text, 1.3 on chrome; tab labels do not scale.

---

## 14. Testing and QA

| Layer | What | Gate |
|---|---|---|
| Domain unit | score (formula-derived oracles incl. `effectiveSeverity` cap/default and multiplier), status matrix (allowed/denied × capability), votes (weights, thresholds, anomaly flags), audience (fatigue, quiet hours, emergency), channels policy table, scenario against the spec's rain `trigger_expr`, sla states, moderation filter, geo snap/jitter determinism, template rule (place + action present) | `npm test` |
| Route tests | every `+api.ts` with `new Request()` against `repos/memory/*`: 400/401/403 table (every write without session → 401), `clientDraftId` replay 200, duplicate vote 409, invalid transition 422, 429 with `Retry-After`, 503 when env missing, OTP send/verify limits, Twilio webhook signature accept/reject, Open311 JSON shape (in and out), public projection allow-list, export headers | `npm test` |
| Screens | `renderRouter` every screen × demo scenario × offline × signed-in/out; `fetch` not called offline; vote optimistic; offline submit creates a draft; submit while signed out opens S-14 and keeps the draft; vision flag off → manual flow; `HazardMap` mocked (`__mocks__/@maplibre/maplibre-react-native.tsx`) renders pins from cached GeoJSON | `npm test` |
| Boundary | no `src/server` import outside `src/app/api`; no secret-looking env names in client code | `npm test` |
| Export smoke (CI) | `expo export --platform web` → serve `dist` → request the literal `/api/open311/v2/requests.json`, `/api/open311/v2/services.json`, `/api/health`, `/console` and assert 200 — catches route-naming mistakes that direct handler tests cannot | CI job |
| Integration (Docker, in CI) | `supabase start` → migrations apply; RPCs; append-only triggers raise; RLS denies anon table reads; rate-limit RPC concurrency; anonymous unlinkability (AC19); `auth.users` → `app_user` trigger | `npm run test:int` (CI job) |
| Perf | `seed-synthetic.ts` 200k reports → `perf-queue.ts` 100 requests → p95 < 400 ms; map 60 fps pan with 500 clustered pins on a 4-year-old mid-range Android (manual, M1) | `npm run perf:queue` (M2) |
| Device QA (`docs/QA.md`) | T1 cold start offline shows cached feed; T2 zero network offline (proxy log); T3 draft survives app kill; T4 draft syncs once on reconnect (replay test); T5 fresh install offline → empty state + drafting works; T6 slow network cache-first; T7 vote optimistic + reconcile; T8 score terms sum to shown score ±1; T9 status push deep-links; T10 VoiceOver/TalkBack pass on S-01/02/04/06/08/14; T11 200 % dynamic type on S-06/S-08; T12 console queue < 400 ms on seeded DB; T13 verification reopen path; T14 quiet hours suppress non-emergency push and SMS; T15 emergency pages on-call by push + SMS and re-pages at 15 min; T16 flag → moderation → hidden for viewers; T17 Apple, Google and email sign-in each complete and the pending draft submits; T18 phone verification and SMS warning delivery (Twilio logs); T19 map offline: pins render without tiles, offline pack renders tiles in airplane mode | manual before release |
| State matrix | Online+cache · Offline+cache · Offline+no cache · Online+expired cache · Signed out · No reports nearby · Low storage · Camera/photo permission denied · No map tiles — Expected / Forbidden columns | `docs/QA.md` |

---

## 15. Milestones (12 weeks, 2 engineers)

| Milestone | Weeks | Deliverables | Done when |
|---|---|---|---|
| **M0 Foundations** (E1, E12 start) | 1 | Scaffold from siblings; tokens; primitives; store; kv; tests; AGENTS/README/QA skeleton; two Supabase Free projects + migrations v1 (PostGIS, enums, RLS, append-only triggers, rate-limit RPC, pg_cron tick, `auth.users` trigger) and verification that pg_cron/pg_net are available on Free; Apple Sign-in capability + Google OAuth clients created; Twilio account, +1 number, Messaging Service, **10DLC/toll-free registration submitted**; MapLibre dev-client spike on iOS and Android; `health`, auth verify, capability matrix, memory repos, fail-closed config; CI (`ci.yml`: typecheck, lint, test, `supabase start` + `test:int`, export smoke, bundle secret grep); EAS init + credentials; first preview deploy; R1 spike (multipart upload + DB query on EAS Hosting); backup dry run through the pooler URL; uptime monitor on `/api/health`; Sentry wiring | CI green; `supabase db reset` clean; `GET /api/health` 200 on preview; trigger test raises on `UPDATE report_event`; boundary test passes; MapLibre renders OpenFreeMap tiles in both dev clients; R1 spike, 10DLC submission and backup dry run recorded in `docs/runbook.md` |
| **M1 Resident intake** (E2, E4 part, E6, E11 status) | 2–4 | S-00…S-08, S-10…S-14; auth (Apple/Google/email) + `requireSession`; drafts + mutations + syncQueue; `/photos`, `/reports`, `/reports/:id/photos`, votes, comments, follow, flag, `/me/*`; duplicate RPC; exposure proxy + OSM extract; status push; `HazardMap` with clustering, peek, offline pack (size measured); demo `calm`/`verify` | T1–T5, T7, T8, T17, T19 on a physical iPhone and Android; screens test zero fetch offline; route tests: replay 200, duplicate vote 409, write without session 401; map 60 fps gate |
| **M2 Console core + lifecycle** (E4 rest, E5, E7, E8, E9 Open311 read, E10) | 5–7 | Staff sign-in; O1, O2, O3, O4 (incl. silent zones), O10 (+ `/equity`), O12; `/ops/queue`, `/ops/analytics`; merge; severity audit; emergency paging (on-call, escalation job, push + SMS + email, `/ack`); phone verification (S-11, `/me/phone*`), Twilio send + webhook; verification flow + autoVerify + coarsenGps + purgePhotos; Open311 read; exports; Census load; `WorkOrderSync` seam; perf seed + test | Seeded 200 orders sorted by score; invalid transition → 422 in drawer; override writes `severity_audit`; Open311 read validates (schema test) and the `.json` URLs pass the export smoke test; p95 < 400 ms at 200k (`docs/perf.md`); verification tests (2 confirm → verified; 1 reject → reopened +1 band; 14 d → auto); T15, T18 |
| **M3 Vision, moderation, hardening** (E2 classifier flag, E3, E6) | 8 | Vision route (Haiku 4.5) + S-05 proposals + feedback + breaker; moderation, users (roles, phones, rota), settings views + `/ops/{moderation,users,settings}`; Open311 inbound POST (`api_key`); `why` screens; recompute job; anomaly flags; backup workflow + first restore drill; accessibility pass 1 | Vision off → identical flow (screens test); proposals < 0.70 → "unclear" (unit); breaker trips (route test); phone/console/server render identical terms (snapshot); Open311 POST creates a report (test); T16; restore drill recorded |
| **M4 Scenarios & alerts — declared cut line** (E9 weather, E11 predictive) | 9–10 | NWS poll; `scenario.ts`; O6; O11 with channel picker; `/scenarios/*`, `/alerts/*`; audience RPC; fatigue budget; `channels.ts`; S-01 hero; S-09; demo `storm`; postEvent; **TestFlight/Play internal review build at end of week 10** | Seeded storm forecast triggers the rain scenario and lists matching open reports; audience excludes users with 2 deliveries in 7 d and quiet-hours users unless emergency; send writes deliveries per channel and receipts; SMS delivery status arrives via webhook; T14; hero absent in `calm`; review build submitted |
| **M5 Release** (E12) | 11 | Accessibility audit fixes + `docs/accessibility.md` (VPAT-lite); `docs/QA.md` executed; privacy labels (App Store) + Play Data Safety (incl. phone number, photos, location); terms/privacy pages with SMS terms; production builds; `eas deploy --prod`; README "Where the AI is / Where the server is" | T1–T19 recorded; production builds succeed; store review feedback addressed; `docs/gap-analysis.md` lists every spec row with done / partial / deferred |
| **Buffer** | 12 | Review-rejection fixes, pilot-city data swap (ped counts, wards), 10DLC follow-up, overflow | — |

Overflow rule: if M2 overruns, it consumes M4's weeks first; if M4 then cannot fit, it is cut whole (D8) and M5 starts no later than week 11.

---

## 16. Acceptance criteria (global, testable)

1. CI green (`typecheck`, `lint`, `test`, `test:int`, export smoke, bundle secret grep) on every merge to `main`; `npm test` runs with no network and no Docker.
2. A report drafted offline is created exactly once after reconnect: replaying `POST /v1/reports` with the same `clientDraftId` returns 200 and the same id (route test; device T4).
3. Score shown on S-07/S-08 equals the server's `score` within ±1 and its five terms equal `score_terms` (snapshot test; T8); `effectiveSeverity` never exceeds 3 without `severity_confirmed` and defaults to band 2 "unrated" when no resident answer exists (unit).
4. No non-staff response contains `home_geom`, watch areas, phone numbers, internal notes, `install_id`, precise `geom` for reporter-linked reports, or staff-only photos (allow-list test over `toPublicReport()` and Open311/export paths).
5. `UPDATE`/`DELETE` on `report_event`, `severity_audit`, `audit_log` fail at the DB (integration test in CI).
6. Queue p95 < 400 ms with 200k seeded reports (`docs/perf.md`).
7. Every screen renders with cached data and `fetch` uncalled when offline, with the OFFLINE banner; the map renders cached pins without tiles (screens test; T19).
8. Vote: second vote by the same account → 409; no session → 401; new account weight 0.6; score moves (unit + route).
9. Status transitions outside the machine → 422; `completed` requires an `after` photo; `verified` reachable only via verification or auto-verify (full matrix unit test).
10. A user never receives a third predictive alert (push or SMS) within 7 days except `emergency` (unit on `audience.ts`; delivery-count test).
11. Vision disabled → identical flow (screens test); enabled → < 0.70 renders "unclear"; `VISION_DAILY_MAX` reached → route returns `{disabled: true}` and the flow continues (route test).
12. Open311 `requests.json` validates against the GeoReport v2 field set and maps statuses per Appendix B; `POST requests.json` with a valid `api_key` creates a report (tests).
13. Every alert, push and SMS template names a specific place and a specific action, and SMS templates fit one GSM-7 segment for the default copy (template tests over `channels.ts`).
14. Accessibility: every `Pressable` ≥ 44 pt; severity never colour-only, including map pins (widget tests); T10/T11 recorded.
15. Emergency: unacknowledged after 15 min → second page recorded in `report_event` (job test with fake clock); T15.
16. Moderation: flagged photo/comment hidden from non-staff within one request after staff action; blocked user's content invisible to the blocker (route tests); T16.
17. Rate limits hold across two parallel route instances (integration test calls the RPC concurrently).
18. Backup: nightly `backup.yml` produces a DB dump and a Storage sync; a restore into a scratch project is performed once before release (`docs/runbook.md`).
19. Anonymous unlinkability: for every report with `reporter_display = anonymous`, `reporter_id` is NULL, all its photos have `uploader_id` NULL, and no `report_follow` or `report_vote` row references the creating account (integration test in CI).
20. Open311 collection URLs (`/api/open311/v2/requests.json`, `services.json`) return 200 from the exported server bundle (export smoke test in CI).
21. SMS: a verified, opted-in user with no device receives a status SMS; a user without verification receives none; Twilio `delivered`/`failed` callbacks update `alert_delivery.status`; a forged callback signature → 403 (route tests; T18).
22. Every write route returns 401 without a session; the screens test shows S-14 opening from the shutter when online and from S-06 submit when offline, with the draft preserved in both cases (route + screens tests; T17).
23. Free-plan guardrails: `/api/health` reports database and Storage usage, and the uptime monitor pings it every 5 minutes in both projects (runbook evidence); photos stored are ≤ 600 KB (route test rejects larger).

---

## 17. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | EAS Hosting (workerd) limits: request time/CPU, body size, driver compatibility | M0 spike (multipart upload + Supabase query + Twilio + Resend calls); results in `docs/runbook.md`; handlers short, jobs chunked; fallback `@expo/server` Node adapter on Fly.io/Railway with identical handlers; signed-URL upload as the alternative if body limits bite |
| R2 | Supabase Free: pausing after 7 idle days, no backups, 500 MB / 1 GB / 5 GB egress caps | Uptime pings as keep-alive; own nightly backups; photo size caps + thumbnails; usage in `/api/health` with an upgrade trigger at 70 %; runbook for un-pausing |
| R3 | Vision proposals wrong, over-trusted, or costly | Floors, enum constraint, "unclear", corrections stored, flag, 8 s timeout, daily breaker, governance page; model env-switchable |
| R4 | Photos with faces/plates (no blur in v1) | Staff-only until triage, guidance, exact-upload preview, private bucket, hide/flag/takedown; Phase 2 on-device blur |
| R5 | Vote brigading / inequity | One vote/account, OAuth accounts, down-weighted new accounts, per-capita with floor, saturation, 22 % cap, anomaly flags, public `/equity` gap table |
| R6 | Sign-up friction hurts the 60-second promise | Sign-in only at first submit; Apple/Google two taps; draft preserved; browsing never requires it; measured by drafts stuck in `needs_sign_in` (S-12 count) |
| R7 | Two-sided cold start | Open311 inbound lets the city push its backlog; demo scenarios; console value first (§16) |
| R8 | Scope creep into Phase 2 | Disabled sidebar items; `docs/gap-analysis.md` with spec quotes |
| R9 | StudySpace files in flux | Copy from nmi; StudySpace via `git show HEAD:` |
| R10 | MapLibre native module build issues or tile provider outage | M0 dev-client spike on both platforms; style URL is configuration; self-hosted PMTiles fallback; pins render without tiles |
| R11 | App Store review (UGC 1.2, accounts, Sign in with Apple, camera, location, privacy labels) | Flag/moderation/block/terms/contact; delete-my-data; Apple sign-in offered alongside Google; permission strings; review build at week 10 |
| R12 | NWS gaps/outages | Staleness badge; scenarios evaluate only on forecasts < 60 min old; queue works on last-known data |
| R13 | Legal pushback on documented notice | Mitigation timestamps first-class (liability clock), as the spec argues (§13) |
| R14 | 200k-row queue performance | Composite indexes + keyset pagination; measured in M2 |
| R15 | Silent job failures (privacy obligations like coarsenGps) | `job_run` + health + uptime alerts; CI test for each job's chunk function |
| R16 | Schedule | 2-engineer assumption stated; M4 is the cut line; buffer week; review build early |
| R17 | 10DLC / toll-free registration delay filters SMS | Submitted in M0; SMS treated as best-effort beside push/email until approved; status tracked in runbook |
| R18 | OAuth setup churn (Apple capability, Google consent screen) | Done in M0 on preview; separate client IDs per environment |

---

## 18. Verification steps (how the owner checks the work)

```bash
npm run typecheck && npm run lint && npm test
npx supabase start && npm run test:int                 # Docker; also runs in CI
npm run perf:queue                                     # M2+, prints p50/p95 → docs/perf.md
npx expo export --platform web && eas deploy           # preview; then GET https://<host>/api/health
# device QA: docs/QA.md T1–T19; record results
# demo: rootcause://?demo=storm ; rootcause://?demo=verify ; console at <host>/console
```

---

## 19. Owner decisions (resolved 2026-10-05)

| # | Decision | Resolution | Consequence in this plan |
|---|---|---|---|
| D1 | Pilot area | New Brunswick, NJ (default accepted) | Census block groups for Middlesex County; OSM extract bbox; `EXPO_PUBLIC_PILOT=new-brunswick-nj` |
| D2 | Map | **MapLibre + OpenStreetMap-based tiles (OpenFreeMap)** | §3.3, §9.6; native + web; offline pack optional; deviation from sibling SVG maps |
| D3 | Resident identity | **Sign-up required for writes (Apple / Google / email); anonymous identity per report allowed; no address verification** | §3.4; S-14; spec §11 "submit without account" deferred |
| D4 | Vision assist | **On, `claude-haiku-4-5`**, breaker 500/day | §3.6 |
| D5 | Console in v1 | **Included** | §10 |
| D6 | Languages | **English only** | §3.9; spec EN/ES/ZH/VI deferred |
| D7 | Supabase plan | **Free** (both projects) to start | §3.2 guardrails; own backups; keep-alive pings; **expect the production project to move to Pro (≈ $25/mo) during the pilot** when Storage passes ≈ 1,300 photos or the database passes 250 MB (§23.G) |
| D8 | Weather scenarios in the 12 weeks | Default kept: yes (M4), cut whole if late | §15 |
| D9 | Error tracking | Default kept: Sentry, PII scrubbed, no product analytics | §12 |
| D10 | Work-order system of record | **RootCause owns in v1; `WorkOrderSync` seam; Cityworks Phase 2** | §3.11 |
| D11 | SMS | **Twilio, one +1 number in a Messaging Service, from M2** | §3.12, §11 channel policy; 10DLC started in M0 |
| D12 | Photo ownership / public-records release (spec open question 7) | **Noted**: terms state photos are licensed to the city and may be released under records law; legal confirmation required before launch | `docs/terms.md`, M5 checklist |
| D13 | Anonymous reports carry vote weight (spec open question 4) | Default kept: yes for score, no status updates | §3.4 |

Spec open question 5 (2 am AI-flagged emergency with no staff online) is answered by the on-call rota + 15-minute re-page (push + SMS) + 911 line; the city must staff the rota.

---

## 20. Scope boundaries

### 20.1 Spec items deferred, with reasons
| Item | Spec | Reason | When |
|---|---|---|---|
| Cityworks/Cartegraph sync | §14 Phase 1, integrations "Required for pilot" | No vendor sandbox or credentials for the pilot; seam + status mapping built now | Phase 2 (D10) |
| Submit a report without any account | §11 Anonymous role | Owner decision D3 (accounts required for writes); anonymous *identity* remains | Revisit after pilot |
| Languages beyond English | §12 EN/ES/ZH/VI | Owner decision D6 | Phase 2 |
| Voice alert channel | §5 Notify | SMS covers the degraded path; voice needs an IVR vendor | Phase 2 |
| Face/plate blur | §13 | Needs an on-device ML module or a vision service; staff-only gate until triage instead | Phase 2 |
| Address verification for voting | §4.3 | Participation vs integrity trade-off left to the city (D3) | Phase 2 |
| Full VPAT | E12 | `docs/accessibility.md` conformance notes in v1 | Phase 2 |

### 20.2 Phase 2/3 (spec §14)
Bundling suggestions, crews & dispatch (O5), urban forestry (O7), allergen/pollen (O8, R10–R12), budget & CIP (O9), on-device live detector, species ID at quality, millimetre severity, incident/recurrence model and risk heat layer, trust score, device-fingerprint anomaly detection beyond the simple flags, multi-tenant deployment, SOC 2.

---

## 21. Cost model (monthly, approximate, pilot scale)

| Item | Estimate | Note |
|---|---|---|
| Supabase Free × 2 projects | $0 | upgrade trigger at 70 % of 500 MB DB / 1 GB Storage / 5 GB egress |
| EAS (builds + Hosting) | per Expo pricing page; verify free-tier build quota in M0 | |
| Anthropic vision (Haiku 4.5) | ≤ $2.50/day at 500 analyses (`VISION_DAILY_MAX`) → ≤ $75 | typical pilot far lower |
| Twilio | number ≈ $1.15; outbound US SMS ≈ $0.0083/segment (1,000 SMS ≈ $8); 10DLC brand/campaign fees (one-time + small monthly) | status alerts mostly push, so SMS volume is low |
| Resend email | free tier (3k/month) | |
| Sentry, uptime monitor | free tiers | |
| Backups (Backblaze B2 or R2) | < $5 | Storage grows with photos (~0.5 MB each) over 7 years |
| OpenFreeMap tiles | $0 (no SLA) | fallback PMTiles on R2 ≈ $0–1 |
| Apple Developer / Google Play | $99/yr / $25 once | |
| NWS, OSM, Census | $0 | attribution required |

---

## 22. Operations

- **Environments:** `development` (local Supabase via `supabase start`), `preview` (Supabase Free project + EAS preview + Twilio test credentials), `production`. EAS environment variables map one-to-one.
- **Migrations:** `supabase/migrations` is the only schema source; CI applies them to a fresh local DB; release applies `supabase db push` to preview, then production, after review. No ad-hoc SQL in production. Every migration must keep the previous native build working (expand → migrate → contract; never rename or drop a column that a live app version still reads).
- **CI (`.github/workflows/ci.yml`):** typecheck, lint, unit/route/screens tests, `supabase start` + `test:int`, `expo export --platform web` + export smoke + secret grep over `dist/`. (Deviation from siblings, which have no CI.)
- **Backups (`backup.yml`, nightly):** `pg_dump` of production through the Supavisor session-pooler URL (IPv4 — Supabase's direct database host is IPv6-only without the IPv4 add-on, and GitHub-hosted runners have no IPv6) to an encrypted external bucket (object lock, 35-day retention) and `rclone sync` of the Storage bucket via its S3-compatible endpoint; dry run in M0, restore drill in M3 and before release; procedure in `docs/runbook.md`. On the Free plan this is the only backup.
- **Monitoring / keep-alive:** Sentry; uptime check on `/api/health` every 5 min for preview and production (keeps Free projects from pausing, reports job staleness and quota usage); alerts to the staff email list and the director's SMS.
- **Runbook (`docs/runbook.md`):** un-pause a Supabase project, rotate keys, disable vision, pause alerts/SMS, restore from backup, grant roles, switch map style URL to the PMTiles fallback, 10DLC status, R1 spike results.

---

## 23. Revision 4 decisions (from the six-lens verification of rev 3; these supersede conflicting text above)

### 23.A Sign-in gate (blocking)
The first server write is the photo upload, not the submit. Online and signed out: shutter → S-14 sheet → `POST /v1/photos` → S-05. Offline: draft saved → S-06 → sign in at submit → queued. `/v1/photos` and `/v1/vision/analyze` keep the `resident` capability; AC22 stands. Friction is measured without analytics: the device-local count of drafts in `needs_sign_in` (S-12) and a server count of accounts older than 24 h with zero reports (`/api/health` under `funnel`).

### 23.B Auth email (blocking)
Supabase's built-in mailer sends 2 emails/hour to organisation members only. M0 configures, in both projects: Auth → SMTP = Resend SMTP relay with a verified sending domain (`STAFF_EMAIL_FROM`); Auth email rate limit raised to the expected sign-in peak; the Magic Link / OTP template rewritten to show `{{ .Token }}` (6-digit code typed in app; `rootcause://auth/callback` and the console URL allow-listed as redirect URLs for the link variant); email OTP expiry 600 s. Client: `sendEmailCode(email)` → `signInWithOtp({ email })`, `verifyEmailCode(email, code)` → `verifyOtp({ email, token: code, type: 'email' })`. Resend Free = 3,000/month **and 100/day** across sign-in codes, staff paging and injury notices → budget the $20/month tier before the pilot (§21); new risk R19 "auth email delivery".

### 23.C Apple token revocation and account deletion (major)
Apple requires token revocation when an account that used Sign in with Apple is deleted. After `signInWithIdToken` the app posts `credential.authorizationCode` to `POST /v1/me/apple-link` within 5 minutes; the server exchanges it at `appleid.apple.com/auth/token` (client secret = ES256 JWT minted per call from `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` — server env only) and stores the refresh token encrypted in `app_user.apple_refresh_token`. `DELETE /me` order: revoke at `/auth/revoke` (best-effort, logged) → de-identify → `auth.admin.deleteUser(id)` → sign out. Schema: `app_user.id` has **no** FK to `auth.users` (trigger-populated) and gains `deleted_at`; on deletion the user's `report_vote` rows are summed into `report.orphan_vote_weight` (treated like `reporter_vote_weight` by the community term) and removed; `vote_count` is unchanged. Route test covers the revoke call and the tombstone.

### 23.D Anonymous unlinkability, extended (major)
For `reporter_display = anonymous`: the creation `report_event` has `actor_type = 'reporter_anonymous'` and `actor_id NULL`; `vision_feedback` rows are written at submit time with the identity choice applied (`user_id NULL`); the reporter of an anonymous report is never addressed by verification, status push or follow (only voters are asked); `POST /v1/reports` never logs user id and report id in the same event and Sentry scrubs `user.id` on that route. AC19 additionally asserts `report_event.actor_id IS NULL` for the creation event, `vision_feedback.user_id IS NULL`, and no `verification` row by the creating account; a log-shape unit test covers the route.

### 23.E Provider × platform (major)
| Platform | Providers | Setup |
|---|---|---|
| iOS | Apple (native `expo-apple-authentication`; nonce: SHA-256 to Apple, raw to Supabase, via `expo-crypto`), Google (`@react-native-google-signin/google-signin`), email code | `ios.usesAppleSignIn: true`; Supabase Apple provider client IDs = `com.27363.rootcause` (+ dev-client id) |
| Android | Google, email code (Apple not offered; Guideline 4.8 binds iOS only) | Android OAuth clients registered with the EAS preview/production keystore SHA-1s and the Play App Signing SHA-1; `webClientId` in Supabase's Google authorized client IDs |
| Web console | Email code, Google (Google Identity Services ID token) | Web client ID authorized in Supabase |
Dependencies added to §5: `@supabase/supabase-js`, `expo-apple-authentication`, `expo-crypto`, `@react-native-google-signin/google-signin`. T17 = "iOS: Apple, Google, email; Android: Google, email — each completes and the pending draft submits". `display_name`: the `auth.users` trigger copies `raw_user_meta_data->>'full_name'` when present; after an Apple first sign-in S-14 sends `credential.fullName` to `PATCH /v1/me`; S-06 asks for a display name the first time Named or Initials is chosen while `display_name` is NULL.

### 23.F Map (major)
- **Bundled style.** The app ships `assets/map/style.json`, a CI-refreshed snapshot of the OpenFreeMap `liberty` style with absolute tile/glyph/sprite URLs (`scripts/fetch-map-style.ts`), passed as an object (`mapStyle` on native, `style` on web). The style therefore always loads locally and the report GeoJSON layers render even when every tile request fails; `EXPO_PUBLIC_MAP_STYLE_URL` only selects which remote style the snapshot script and the offline pack use. Test (replaces the T19/AC7 wording): no network + empty ambient cache → pins visible on a plain background with the "tiles unavailable" StatusLine.
- **Web bundle.** `maplibre-gl` is pinned to a version whose single-file build embeds its worker, or (v6) `dist/maplibre-gl-worker.mjs` + `dist/maplibre-gl-shared.mjs` are copied into `public/` and `maplibregl.setWorkerUrl('/maplibre-gl-worker.mjs')` is called before constructing the map; the map is constructed only inside `useEffect` (pages are evaluated in Node during export); `maplibre-gl/dist/maplibre-gl.css` is imported. The M0 spike covers the exported web console, and the export smoke test requests the worker asset.
- **Fallback is a server-side switch, not an env change.** Fallback bundle (built and smoke-tested in M0/M2): Planetiler OpenMapTiles-schema PMTiles of the pilot bbox + copies of the liberty style, non-ideograph glyph ranges and sprites on R2 (CORS + range requests); the web bundle registers the `pmtiles` protocol at startup; the active style source is read from `GET /api/v1/config` (cached; bundled value as default). Runbook drill "switch to fallback and back" joins the M3 restore drill. `pmtiles` added to dependencies.
- **Offline pack.** Zoom 11–14 (OpenFreeMap's source maxzoom; higher zooms overzoom), `offlineManager.createPack({ mapStyle, bounds, minZoom: 11, maxZoom: 14 })`, expected ≈ 12–15 MB; the dated tile path rolls weekly, so S-12 shows the pack date and offers a refresh.
- **Spec carry-over.** §20.1 gains "Self-hosted vector tiles (spec §5) → public OpenFreeMap instance, no SLA (D2); self-hosting is the fallback bundle — Phase 2 if the city requires it". §1.4/§14 gain "cached tile fetch p95 < 150 ms (spec §12), measured in the M0 spike". AGENTS.md rule reads "Map provider details live in `src/ui/HazardMap*.tsx` and `src/services/mapOffline.ts` only"; the jest mock exports `MapView`, `Camera`, `GeoJSONSource`, `CircleLayer`, `SymbolLayer` as plain views.

### 23.G Supabase Free guardrails (major)
- **Egress** counts every PostgREST read made by the routes **and the backup dump** (no wire compression). Dump policy: nightly full `pg_dump` only while `pg_database_size() < 100 MB` (≈ 1.8 GB/month); above that, weekly full dump + nightly incremental export by `created_at`/`updated_at` of the append-only tables (`report_event`, `audit_log`, `alert_delivery`, `sms_message`, `report_vote`, `verification`, `severity_audit`) and of `report`/`report_photo` rows changed since the last run; bytes logged per run. Egress is read weekly from the dashboard Usage page (not visible from SQL) into the runbook. DB upgrade trigger drops to 50 % (250 MB).
- **Storage** ≈ 1,300 photos (≈ 600–1,000 reports) before the 70 % trigger; expect Pro during the pilot (D7, §21). Optional: full image 1024 px / quality 0.65 (≈ 200–300 KB) to roughly double the budget. The trigger is measured as the byte sum of `storage.objects` metadata.
- **Perf environment.** The 200k-row gate runs against local `supabase start`; a bounded run (≤ 20k reports, `pg_database_size() < 100 MB`) runs on preview to measure Free compute latency; both go to `docs/perf.md`; `seed-synthetic.ts` refuses a non-local database URL when the projected size exceeds 250 MB; runbook gains "exit read-only mode (delete, VACUUM, disable read-only)".
- **Project cap** is two active Free projects **per user across all organisations** (paused ones do not count): preview + production, and the owner must hold no other active Free project under that account. Restore drill: into local `supabase start` pinned to the project's Postgres major (same extensions), and before release into preview after a snapshot. `backup.yml` installs `postgresql-client-<major>` from PGDG matching `select version()` and fails if the dump is empty or the majors differ.
- `pg_net` timeout is passed explicitly (`timeout_milliseconds`): 25 000 for the tick (see 23.H), and `jobs/tick` returns within 20 s; the M0 check records the installed `pg_net` version.

### 23.H SMS (blocking + major)
- **10DLC prerequisites first.** M0 publishes minimal public `/privacy` and `/terms` pages on the first preview deploy containing the SMS program description (status updates + ≤ 2 predictive alerts/week), "Msg & data rates may apply", "Reply STOP to opt out, HELP for help", and the exact sentence "We do not share, sell, or provide your mobile phone number or messaging consent data to third parties or affiliates for marketing or promotional purposes"; a hosted S-11 opt-in mock image; two sample messages. Then the brand + campaign (or toll-free verification) is submitted. **D14** (owner): registrant for the Twilio brand (city EIN vs vendor EIN) and sender type (local 10DLC Low Volume Mixed vs toll-free).
- **Blocked, not filtered.** Until approval no SMS leaves our number; push/email/inbox carry everything; phone verification uses Twilio Verify (exempt), so S-11 works from M2. If the campaign is not approved by week 7, the SMS legs of T15/T18 move to the buffer week.
- **Fatigue budget** = `COUNT(DISTINCT alert_id)` over `alert_delivery` rows for the user in the trailing 7 days where `channel IN ('push','sms')` and `alert.severity <> 'emergency'`; audience requires `< 2`; emergency alerts bypass the check and are excluded from the count but still write rows; status-change notifications are not `alert_delivery` rows and never count. AC10 and the M4 done-when use this definition (one push+SMS warning consumes one unit).
- **Dispatch inside the tick.** SMS chunk = 20 per tick (6-way `Promise.allSettled`); before each Twilio call the `sms_message` claim row (UNIQUE `alert_id + user_id + channel`) is inserted with status `queued`, so a cancelled tick never re-sends; `warning` alerts create Twilio scheduled messages (`ScheduleType=fixed`, `SendAt` = onset − 4 h) at approval time; `emergency` sends immediately in 20-per-tick chunks and O11 shows the expected dispatch time (N/20 minutes) and the campaign's daily cap; push batches (100 per request) go first; pg_net timeout for the tick = 25 s.
- **Webhook contract.** `TWILIO_WEBHOOK_URL` = `https://<production alias>/api/webhooks/twilio`, configured on the Messaging Service and used verbatim for the HMAC-SHA1 validation (never `request.url`); body via `request.formData()`; status updates use a rank (queued < sent < delivered; failed/undelivered terminal) and ignore regressions; 200 on any valid signature, 403 otherwise. Callbacks update `sms_message.status` (and `alert_delivery` for alerts); escalation reads `sms_message`.
- **Schedule.** `sms_message` ships in migrations v1 (M0); `channels.ts` (status + paging rows) moves to M2, predictive rows are added in M4; T18 = "phone verification and status-change SMS delivery"; new T20 (M4) = "predictive warning SMS delivered; status visible in O11 history". One Twilio account and one registered Messaging Service are shared by preview and production; preview runs `SMS_ENABLED=false` by default with an `SMS_ALLOWLIST` of tester numbers when on; Twilio test credentials are used only in route tests against `repos/memory`. `SMS_DAILY_MAX` tenant breaker; Twilio Geo Permissions US/CA only.
- **Costs (§21).** Local number $1.15 (toll-free $2.15); outbound $0.0083/segment + carrier surcharge ≈ $0.002–0.005 → 1,000 SMS ≈ $11–13; brand $4 + campaign vetting $15 one-time; campaign $1.50/mo (Low Volume Mixed) or $10/mo (Standard); inbound STOP/HELP replies $0.0083 each; Verify ≈ $0.05 per success.

### 23.I Vision route (major)
- `VISION_MODEL` is a zod enum `['claude-haiku-4-5']`; any other value → 503 / `{disabled: true}` (fail-closed config test). Model changes are code changes with a per-model request shape (§3.6).
- Structured output adds `severity_band: 1 | 2 | 3` with `severity_confidence`; stored in `severity_ai` only when ≥ 0.70; S-05 shows it as a proposal under the "unclear" rule; `severity_audit.ai_value` therefore has a source.
- Response handling: read `stop_reason` before `parsed_output`; anything other than `end_turn`, a null `parsed_output`, or a zod failure → `{ proposals: null, reason: 'unclear' }` with 200, logged with `response.model`, `stop_reason` and `usage`; `ai_json` stores the raw content and usage. Client: `new Anthropic({ apiKey, timeout: 8_000, maxRetries: 0 })` per request; the M0 spike runs one `messages.parse` call with a JPEG on the preview deployment and records latency.
- **Kill switches vs limits.** `VISION_ENABLED` / `SMS_ENABLED` are server-side kill switches for the runbook; the runtime limits are `tenant.vision_daily_max` and `tenant.sms_enabled`, seeded from `VISION_DAILY_MAX` by `supabase/seed.sql` and edited in `/console/settings`; an analysis or send requires both (AND). AC11 = "tenant `vision_daily_max` reached, or `VISION_ENABLED=false` → `{disabled: true}` and the flow continues (route tests for both)". Appendix C annotates `VISION_DAILY_MAX=500` as a seed value.

### 23.J Consistency fixes (minor)
`alert.body jsonb` holds per-channel copy `{ push, sms, email, inbox }` and replaces `body_i18n` (§20.1 row: per-language bodies return with EN/ES/ZH/VI). The client key is `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (legacy anon JWT accepted in the same argument). M1 adds the `pushReceipts` job and the `/r/[id]` public report page (share-link target; Appendix A row); S-11 ships in M1 without `/phone`, which is M2. M5's checklist carries the D12 legal confirmation. Rate-limit counters: "hourly and daily windows". Staff sign in "by email code or Google". OAuth accounts cost more to farm than anonymous accounts would.

## Appendix A — Spec screen → app route map

| Spec | App | Route |
|---|---|---|
| R1 | S-01 | `/` |
| R2 | S-02 | `/map` |
| R3 | S-04 | `/report/capture` |
| R4 | S-05 | `/report/analysis` |
| R5 | S-06 | `/report/form` |
| R6 | S-07 | `/report/submitted` |
| R7 | S-08 | `/report/[id]` |
| R8 | S-03 | `/alerts` |
| R9 | S-09 | `/alert/[id]` |
| R13 | S-10 | `/me` |
| R14 | S-11 | `/settings`, `/watch-areas`, `/phone` |
| — | S-00 / S-12 / S-13 / S-14 | `/onboarding`, `/data`, `/privacy`, `/terms`, `/sign-in`, `/auth/callback` |
| O1–O4, O6, O10–O12 + moderation/users | console | `/console/*` |

## Appendix B — Status mapping (spec table, line ~2101)

| RootCause | Open311 | Resident-facing wording |
|---|---|---|
| new | open | Received |
| triaged | open | Confirmed by inspector |
| assessed | open | Assessed in the field |
| mitigated | open | Made safe temporarily |
| scheduled | open | Scheduled — window given |
| completed | closed | Fixed — please verify |
| verified | closed | Fix confirmed by a resident |
| rejected | closed | Not city-owned — here's who owns it |

## Appendix C — Environment variables (`.env.example`)

```
# server only (never EXPO_PUBLIC_)
SUPABASE_URL=            SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=       VISION_MODEL=claude-haiku-4-5   VISION_ENABLED=true   VISION_DAILY_MAX=500
TWILIO_ACCOUNT_SID=      TWILIO_AUTH_TOKEN=              TWILIO_MESSAGING_SERVICE_SID=   SMS_ENABLED=true
RESEND_API_KEY=          STAFF_EMAIL_FROM=
JOB_SECRET=              OPEN311_API_KEYS=               NWS_USER_AGENT="RootCause/1.0 (contact: …)"
SENTRY_DSN_SERVER=       EXPO_ACCESS_TOKEN=              # optional, push receipts
# client (inlined at build time; public configuration, not secrets)
EXPO_PUBLIC_API_URL=https://<eas-host>                   # relative /api on web dev
EXPO_PUBLIC_SUPABASE_URL=   EXPO_PUBLIC_SUPABASE_ANON_KEY=
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=   EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=   EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=
EXPO_PUBLIC_MAP_STYLE_URL=https://tiles.openfreemap.org/styles/liberty
EXPO_PUBLIC_VISION=on       EXPO_PUBLIC_PILOT=new-brunswick-nj   EXPO_PUBLIC_SENTRY_DSN=
```

## Appendix D — AGENTS.md for this repo (to be created in M0)

```
# Expo HAS CHANGED
Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.
Sibling projects with the same stack and design system: ../nmi-typhoon-watch (read its src/ui and src/data first), ../studyspace.
Spec: ../docs/3_NewJersey_2.HTM. Plan: .omc/plans/rootcause-v1-production-plan.md.
Rules: src/domain has no RN/Expo imports. src/server is imported only from src/app/api. Secrets never reach the client.
No in-memory state in routes (workerd). Every public response goes through toPublicReport(). Every write route requires a session.
Every number on screen is explainable (see /why). Demo data is labelled. No spinners. Offline is not an error.
Before touching src/server/vision.ts load the claude-api skill. Map provider details live in src/ui/HazardMap*.tsx only.
```

---

## Changelog

**Rev 2 (Critic review applied):** single photo upload path (`/v1/photos`) with `clientDraftId` idempotency and a retry policy; vision route returns duplicates; `/reports/:id/photos` for "add to existing" and after-photos; `effectiveSeverity` rule, `k`/floor defaults, formula-derived oracles, multiplier timing; public projection (`toPublicReport`, `geom_public`, 30-day coarsening of stored GPS for anonymous reports, staff-only photos until triage, de-identify-on-delete); Open311 in/out moved into M2, Cityworks sync deferred with reasons (D10), sync seam added; DB-backed rate limits, anomaly flags, new-account down-weight, vision breaker; emergency paging (on-call rota, escalation job, email, 911 line, read-time SLA); CI, two Supabase projects, staged migrations, backups + restore drill, Sentry, uptime checks; moderation queue, blocks, terms, privacy labels, early review build; verification + perf moved to M2, M4 declared cut line, buffer week, staffing stated; capability matrix + Admin › Users; chunked `jobs/tick`; fail-closed config; definitions for `open_hazard_index`, SLA numeric values, PoP as confidence, near-miss weight, earliest-5 voters; offline mutations queue; library photo location confirmation; open questions 4/5/7 added; cost model.

**Rev 2.1 (second Critic pass — all 9 blockers confirmed resolved; small defects fixed):** Open311 collection routes renamed `services.json+api.ts` / `requests.json+api.ts` and an export smoke test added (AC20); anonymous unlinkability rule (`reporter_vote_weight`, NULL `uploader_id`, no reporter follow/vote rows; AC19); `effectiveSeverity` default band 2 "unrated" for Open311/inspection intake; moderation/users/settings and Open311 POST moved from M2 to M3 with an overflow rule; backups through the Supavisor pooler URL with an M0 dry run; `x-install-id` never the sole rate-limit key; Turnstile widget ships behind a default-off flag; expand/contract migration rule.

**Rev 4 (six-lens adversarial verification of rev 3 — 54 agents, 21 confirmed findings, 3 refuted; 2026-10-05):** §23 added and referenced from the affected lines: sign-in gate moved to the first server write (photo upload) with AC22/T17 reworded; custom SMTP + `{{ .Token }}` template + 600 s expiry for email codes, Resend tier budgeted, R19; Apple token revocation on deletion with server-side Apple key, `app_user` without FK cascade + `deleted_at`, `orphan_vote_weight`; unlinkability extended to `report_event.actor_id`, `vision_feedback.user_id`, verification and logs (AC19); provider × platform matrix and T17; bundled map style, web worker handling, server-side fallback switch via `/api/v1/config`, offline pack z11–14, tile p95 NFR; Free-plan egress/dump policy, Storage budget → expected Pro during pilot (D7), perf environment, per-user project cap, pg_dump major pin, explicit pg_net timeouts; 10DLC prerequisites in M0 and D14, "blocked not filtered", Twilio Verify replaces `phone_otp`, fatigue = distinct non-emergency alerts, 20-per-tick dispatch with `sms_message` claim rows and scheduled messages, webhook URL binding, `channels.ts` to M2, T18/T20, shared Messaging Service with preview allow-list, costs; `VISION_MODEL` enum, `severity_band` proposal, response-handling rules, kill switches vs tenant limits (AC11); `alert.body`, publishable-key naming, milestone coverage gaps.

**Rev 3 (owner decisions D1–D13, 2026-10-05):** map switched to MapLibre + OpenFreeMap on native and web with offline pack and PMTiles fallback (D2); accounts required for all writes via Apple/Google/email, sign-in at first submit, S-14 added, anonymous identity kept with unlinkability, spec §11 "submit without account" deferred (D3); vision model `claude-haiku-4-5` with no effort/thinking parameters and a 500/day breaker (D4); English only, i18n layer removed, AC13 replaced by the place-and-action template rule (D6); Supabase Free with keep-alive pings, quota guardrails, photo size caps and thumbnails, own backups (D7); Twilio SMS with Messaging Service, OTP phone verification, webhook, channel policy table, 10DLC lead time in M0, voice deferred (D11); D12 recorded; cost model and env vars updated; AC21–AC23 and T17–T19 added.
