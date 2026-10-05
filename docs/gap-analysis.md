# Gap analysis — repository vs. the spec

Spec: `../docs/3_NewJersey_2.HTM` (RootCause prototype v0.9, handoff §1–§17). Plan: `.omc/plans/rootcause-v1-production-plan.md` (rev 3, owner decisions D1–D13). Scope of this comparison: every resident screen (R1–R14), every console view (O1–O12), the extra screens the plan adds, every §17 epic, the §12 non-functional rows that apply to v1, and the §20 deferrals.

Snapshot: **2026-10-05, end of the M0 run (week 1)**. M0 lays foundations, so most rows are *missing (planned Mx)* by design; the M0 screens that exist render from local data only. This file is re-written at the end of every milestone and must list every spec row with done / partial / deferred before release (plan §15 M5). Evidence rows were re-checked against the tree at the end of the run: `npm run typecheck` clean, `npm test` 17 suites / 152 tests green (the integration suite skips without Docker).

Status key: **done** · **partial** (exists, but a named piece is missing) · **missing** (planned, with the milestone) · **deferred** (not in v1, with the reason and the plan section).

## Foundation present at M0 (evidence)

| Piece | Status | Evidence / gap |
|---|---|---|
| Project scaffold (Expo SDK 57, expo-router, TS strict, jest-expo, eslint, EAS profiles, Icon Composer asset) | done | `package.json`, `app.json`, `eas.json`, `tsconfig.json`, `eslint.config.js`, `.vscode/`, `__mocks__/expo-sqlite/kv-store.ts` |
| Domain modules (plan §8) | partial | Present: `types` (zod + enums), `taxonomy` (5 categories, 17 sub-types, sensitivity / ADA / linear), `score`, `status`, `roles`, `votes`, `sla`, `geo`, `time`, `ids`, `pilot`, `demo`. Missing: `audience`, `channels`, `scenario` (M4), `moderation` (M3) |
| Design tokens, primitives, widgets (plan §13) | partial | `ui/{theme,primitives,Screen,icons}` with the §3.8 palette; `severity-widgets` (`SeverityBars`), `score-widgets` (`ScoreBreakdown`), `report-widgets` (list row, `VoteControl`, `StatusTimeline`). Missing: `HazardMap` (+ `.web`), `MapLegend`, `ScenarioCard`, `SignInSheet`, `console/*` |
| Local storage and repos (plan §9.2) | done for M0 | `data/{kv,kv.web,files,files.web,repos}` — versioned keys, sanitised reads, storage guard with notice; `drafts:v1`, feed / alerts cache, prefs, own-report links, session |
| Store | done | `store/{appStore,derived}` — synchronous hydration, derived feed / index / own reports / pending drafts |
| Services | partial | Present: `apiClient` (fetch + zod, 10 s, never throws), `auth` (token plumbing only — Apple / Google / email code in M1), `demo`, `refresh`, `syncQueue` (retry policy of §9.2), `network`, `location`. Missing: `photos`, `camera`, `notifications`, `mapOffline` (M1) |
| Screens | partial | Present and rendering from local data: `_layout` (hydration, `Stack.Protected` onboarding gate), `(tabs)/_layout` (five tabs, Report tap → capture modal), S-00 `onboarding`, S-01 `(tabs)/index`, S-02 `(tabs)/map` as the list form only, S-03 `(tabs)/alerts`, S-04 `report/capture` as a scaffold that states the steps (no shutter), S-08 `report/[id]`, S-10 `(tabs)/me`, S-12 `data`, S-13 `privacy`, `why/score/[id]`, `+not-found`. Missing: S-05, S-06, S-07, S-11, S-14, `/terms`, `/why/index` (M1); S-09, `/alert/[id]` (M4); `/r/[id]`, `/equity`, `console/*` (M2) |
| Server (plan §3.10, §7, §12) | partial | Present: `server/{auth,db,env,http,log,public,ratelimit}`, `server/repos/{types,derive}`, `server/repos/memory/{health,index,reports,users}`, `server/repos/supabase/{health,index,reports,users}` — fail-closed env, JWKS-verified Supabase JWT (`requireUser`, `requireCapability`), `withTiming`, PII-masking logger, `toPublicReport()`, DB-backed rate-limit keys, intake score at insert (`derive.ts`, exposure 0 until the OSM lookup), injectable repos. Routes: `api/health+api.ts`, `api/v1/reports+api.ts`, `api/v1/reports/[id]+api.ts` (GET; PATCH answers 501 until M2). Missing: every other `src/app/api/**/+api.ts` route, `photos`/`exif`, `push`, `sms`, `email`, `nws`, `vision`, `sentry`, `sync/`, `jobs/` |
| Database, CI, hosting (plan §15 M0) | partial | `supabase/config.toml`, `supabase/migrations/0001_init.sql` (PostGIS, enums, RLS on every table, append-only triggers on `report_event` / `severity_audit` / `audit_log`, `rate_limit_hit`, `find_duplicates`, `reports_in_bbox`, `audience_for_hazards`, `auth.users` trigger) and `supabase/seed.sql` (pg_cron tick) exist; a test checks the SQL enums against `taxonomy.ts`, but nothing has applied the migration to a database yet. `.github/workflows/ci.yml` (typecheck, lint, test; `supabase start` + `test:int`; web export + secret grep) and `backup.yml` (nightly `pg_dump` through the pooler + `rclone` Storage sync) exist; the repo has no commits, so neither has run. No preview deploy; the M0 spikes (MapLibre dev clients, R1 upload on EAS Hosting, backup dry run, 10DLC) have their tables in `docs/runbook.md` §10–11 with no measured values |
| Scripts | partial | `scripts/grant-role.ts` (first director). Missing: `build-osm`, `build-census`, `seed-demo`, `seed-synthetic`, `perf-queue`, `backup.sh` |
| Tests (plan §14) | partial | `__tests__/{bundled-data,i18n,migration-enums,screens,storage-guard,boundary}` — taxonomy integrity, string table, SQL enums vs taxonomy, every screen × scenario with zero fetch offline, low-storage drop order, server/client import boundary + no secret-looking env name in client code. `__tests__/domain/{score,status,votes,sla,geo,time,demo}` — formula-derived oracles (worked example .78/.82/.12/.90/.04 → 60, weights sum to 1, bands, multiplier clamped 1.0–1.6), status matrix × capability + evidence rules + mapping tables, vote weights / 1.5 km geo check / thresholds / anomaly flags, SLA states, snap + jitter determinism, quiet hours, demo determinism. `__tests__/routes/{auth,health,reports,public-projection}` (`new Request()` against memory repos) — JWT verify (JWKS cache; tampered / expired / wrong issuer / HS256 refused), `/api/health` 200 and 503, `/api/v1/reports` 400 / 401 / 403 / 201 / replay 200 / 429, `toPublicReport()` allow-list. `npm test`: 17 suites, 152 tests green. `__tests__/int/migrations.int.test.ts` + `jest.int.config.js` exist but the suite is a `TODO(M1)` stub that skips without `SUPABASE_DB_URL`. Missing: audience / channels / scenario / moderation units (modules not written), the remaining route tests (votes 409, 422 transitions, OTP limits, Twilio signature, Open311 shape, export headers), real integration assertions |
| String table | partial, deviation | `src/i18n/{index,en}.ts` — a typed `t()` catalog, English only, with a test. The plan is split: §3.9 adopts exactly this catalog (StudySpace HEAD `src/i18n`), while §2 (UI row), §5 (layout) and the Rev 3 changelog say "no i18n layer". Decision needed: keep it (and amend §2 / §5) or inline literals |
| Docs | partial | `AGENTS.md` (plan Appendix D verbatim), `README.md`, `docs/QA.md` (T1–T19 written, none executed), `docs/privacy.md` and `docs/terms.md` (drafts awaiting legal review, D12), this file, `docs/data-sources.md` (skeleton without read dates), `docs/runbook.md` (procedures written; the 10DLC and R1 spike tables unfilled). Missing: `taxonomy.md`, `accessibility.md`, `perf.md` |
| **App icons and splash** | **placeholder** | `assets/images/{icon,android-icon-background,android-icon-foreground,android-icon-monochrome,splash-icon,favicon}.png` and `assets/expo.icon/` are byte-identical copies of `../nmi-typhoon-watch` (the Expo template symbol on the typhoon app's colours; verified by checksum). They need RootCause artwork — green `#1F6B4F` background, a hazard / root glyph — as an Icon Composer document in `assets/expo.icon`, the Android adaptive set and the 96 px splash image, before the week-10 review build |

## §3 Resident app (R1–R14) and the plan's extra screens

| Spec | Screen | Status | Evidence / gap | Decision |
|---|---|---|---|---|
| R1 | Home / risk feed | partial | S-01 `(tabs)/index.tsx`: open-hazard index with named drivers, ranked local queue with inline vote, barometer — from cached / demo data only; no server feed yet | M1 wires `/v1/reports` + cache; scenario hero M4. "Risk index" ships as the open-hazard index — "what has been reported, weighted by score — not a prediction" |
| R2 | Map + heatmap | partial | S-02 `(tabs)/map.tsx` is the list form (nearest reports, distances, filters) that will remain the screen-reader mirror of the pins; no MapLibre view, no heat layer | M1 adds `HazardMap` (MapLibre + OpenFreeMap, clustering, peek, "Report what I see here"; D2). Heat layer **deferred** — spec R2 note: heat "must be modelled risk, never report density"; the incident model is Phase 2 |
| R3 | Capture (camera) | partial | S-04 `report/capture.tsx` is a scaffold that states the three steps; no camera, no shutter, no draft photo | M1: `expo-camera`, library pick, resize ≤ 1280 px / ≤ 500 KB + 320 px thumbnail, EXIF strip, draft on disk. Live on-device detector **deferred** (Phase 2); spec E2: "the flow must work without it" |
| R4 | AI analysis | missing | — | M1 as S-05: duplicates (PostGIS 25 / 60 m), exposure lookup, approximate address, ADA flag from taxonomy. M3: vision proposals behind a flag. Millimetre severity **deferred** — spec §8 degrade rule, no calibration data (open question 2 answered as "bands, no numbers") |
| R5 | Report form | missing | `CreateReportInputSchema` exists in `domain/types.ts` | M1 as S-06; sign-in requested at first submit only (D3) |
| R6 | Submitted / score breakdown | missing | `ScoreBreakdown` widget and `score.ts` exist | M1 as S-07 |
| R7 | Report detail | partial | S-08 `report/[id].tsx`: evidence, AI read, vote with threshold, five-term score, timeline, nearby, share, follow — local data; no comments, no flag, no server writes | M1: comments, flag, follow / vote mutations through `syncQueue`; photos public only after staff release |
| R8 | Alerts inbox | partial | S-03 `(tabs)/alerts.tsx`: status alerts from local state, real empty state | M1 status push → inbox; predictive M4; seasonal (pollen) **deferred** Phase 3 |
| R9 | Alert detail / briefing | missing | — | M4 as S-09 |
| R10 | Plants hub | deferred | — | Spec Phase 2 (§14) |
| R11 | Plant scan result | deferred | — | Spec Phase 2 |
| R12 | Pollen outlook | deferred | — | Spec Phase 2/3 |
| R13 | Profile / impact | partial | S-10 `(tabs)/me.tsx`: impact framing, signed-out state, links to data and privacy; no server stats, export, delete-my-data or alert rules | M1: `/me` stats, my reports incl. local-only anonymous, export, delete-my-data (de-identify). Trust-score explanation **deferred** (§20.2) |
| R14 | Settings / alert rules | missing | Onboarding stores home area, categories, quiet hours in prefs | M1 watch areas / categories / quiet hours (S-11); M2 phone + SMS opt-in. Allergy sensitivities **deferred** with the allergen module |
| — | S-00 Onboarding | done for M0 | `onboarding.tsx`: home area, categories, quiet hours; no sign-in (D3) | M1 replaces the home-area picker with the map tap once `HazardMap` exists |
| — | S-12 Offline data | partial | `data.tsx`: saved data and times, waiting drafts, simulate offline, demo picker, low-storage notice, reset | M1: failed drafts with reasons, offline map pack download / remove with size |
| — | S-13 Privacy / Terms | partial | `privacy.tsx` renders the plain statements; `docs/privacy.md` and `docs/terms.md` are the drafts; no `/terms` screen, no web pages | M1 `terms.tsx` + web `/privacy`, `/terms`; legal review M5 (D12) |
| — | S-14 Sign-in | missing | `services/auth.ts` is token plumbing only | M1 (Apple, Google, email code; `requireSession`; draft survives) |
| — | `/why/score/[id]`, `/why/index` | partial | `why/score/[id].tsx` renders the real constants next to this report's terms | M2 `/why/index` with the open-hazard index definition |

## §3 DPW console (O1–O12) and the plan's extra views

| Spec | View | Status | Gap | Decision |
|---|---|---|---|---|
| O1 | Overview | missing | — | M2 (`/console/overview`); "AI-override audit" row fed by `severity_audit` from M3 |
| O2 | Triage queue | missing | Bundling suggestions | M2 (`DataTable`, sort / filter / search, duplicate clusters + merge, keyboard). Bundling **deferred** Phase 2 |
| O3 | Work order detail | missing | Assignment to crews; remediation ladder | M2 drawer: evidence release, five bars (`ScoreBreakdown`), status actions constrained by `status.ts`, severity confirm / override → `severity_audit`, mitigation, remediation option pick (recorded only), resident update vs internal note, ack emergency. Crews **deferred** (O5) |
| O4 | Risk map | missing | Composite heat | M2 (`HazardMap.web`, layers, hot blocks, silent zones with "Schedule inspection"). Composite heat **deferred** with the incident model |
| O5 | Crews & dispatch | deferred | — | Spec Phase 2 |
| O6 | Weather scenarios | missing | Backtest | M4 — the declared cut line (D8). Backtest **deferred** (needs incident history) |
| O7 | Urban forestry | deferred | — | Spec Phase 2 |
| O8 | Allergen program | deferred | — | Spec Phase 3 |
| O9 | Budget & CIP | deferred | — | Spec Phase 2 |
| O10 | Equity & SLA | missing | — | M2 (`/console/equity` + public `/equity`); block-group rollups, gap column, SLA matrix at read time (`sla.ts` exists) |
| O11 | Alert composer | missing | — | M4 with channel picker (push / push+SMS / all), SMS segment count, delivery status |
| O12 | Model governance / integrations | missing | Model registry | M2 static page (where AI is / is not, guardrails, status mapping, data sources, failure modes). The registry reduces to one entry (`VISION_MODEL`, `model_version` on photos) |
| — | Moderation | missing | — | M3 (App Store 1.2: flags, hide, blocks) |
| — | Admin › Users | missing | `scripts/grant-role.ts` grants the first director | M3 (roles, staff phones, on-call rota) |
| — | Settings | missing | — | M3 (weights summing to 1.00, SLA config, scenario thresholds, vision daily max, SMS enabled; audited) |
| — | Staff sign-in | missing | — | M2 (`/console/sign-in`, email code or Google) |

## §17 Build backlog (E1–E12)

| Epic | Stories (spec) | Status | Evidence / gap | Decision |
|---|---|---|---|---|
| E1 Foundations | Tenancy, auth (resident + city SSO), PostGIS schema, audit log, CI/CD, observability | partial | Scaffold, domain contracts, fail-closed server env, structured logger, DB-backed rate-limit keys, `0001_init.sql` (PostGIS, enums, `tenant_id` on every table, RLS, append-only triggers on `report_event` / `severity_audit` / `audit_log`, `rate_limit_hit`, pg_cron tick, `auth.users` trigger), `/api/health`, JWKS JWT verify, memory + Supabase repos, `ci.yml` / `backup.yml`. Open: Sentry wiring, preview deploy, uptime monitor, the migration applied once to a real database, the spikes measured. City SSO reduces to staff email / Google sign-in (no IdP in the pilot) | M0 (open items carry into week 2); "do the append-only audit log on day one" — triggers are in the first migration |
| E2 Capture | Camera, on-device classifier, offline queue, photo privacy pipeline | partial | `syncQueue` and `drafts:v1` exist; capture is a scaffold; no photo pipeline | M1 camera + resize + EXIF strip + `/v1/photos` + staff-only until release; classifier flag M3 (server-side, not on-device) |
| E3 Analysis | Severity service, duplicate clustering, exposure lookup, ADA flagging | missing | ADA relevance is in the taxonomy; `derive.ts` sets the flag at insert. Calibration against a LiDAR survey — no survey exists | M1 duplicates / exposure; M3 severity proposal as a band, never a number |
| E4 Report lifecycle | Status state machine, timeline events, comments, verification flow, reopen logic | partial | `status.ts` (8 statuses, `transition()` with capability + evidence rules, resident wording, Open311 mapping), `StatusTimeline` and the `__tests__/domain/status.test.ts` matrix (allowed / denied × capability, evidence rules, mapping tables) exist; no events or comments routes | M1 events + comments routes; M2 verification, reopen (+1 band), auto-verify at 14 d |
| E5 Scoring | Five-term score, materialised queue, weight admin UI, score explanation component | partial | `score.ts`, `ScoreBreakdown`, `/why/score/[id]` and the formula-derived oracle test (`__tests__/domain/score.test.ts`: .78/.82/.12/.90/.04 → 60, weights sum to 1, multiplier clamped 1.0–1.6) exist; the server scores at insert (`repos/derive.ts`, exposure 0 until the OSM lookup) and has no recompute job | M1 exposure inputs + server recompute; M2 queue indexes + keyset pagination; M3 weights UI |
| E6 Voting | Vote endpoints, per-capita normalisation, abuse controls, thresholds & notifications | partial | `votes.ts` (weights 0.6 / 1.0, 1.5 km geo rule, 25 / 100 thresholds, anomaly flags) and `VoteControl` exist; no route | M1 `POST/DELETE /v1/reports/:id/votes` + community term recompute; M3 anomaly flags in the nightly job ("simple v1": rate + install + distance) |
| E7 Console | Queue table, work order detail, merge, assign, mitigate, export | missing | Assign (crews) | M2 all but assign; assign **deferred** with O5 |
| E8 Map | Vector tiles, layer toggles, heat layer, clustering at zoom | missing | Heat layer | M1 MapLibre + OpenFreeMap tiles + clustering (D2); M2 console layers; heat **deferred** |
| E9 Integrations | Open311 in/out, Cityworks sync + webhooks, GIS ingest, weather poll | missing | Cityworks | M2 Open311 read + exports + Census / OSM ingest; M3 Open311 POST; M4 weather poll. Cityworks **deferred** (D10) — seam `src/server/sync/` and vendor status-mapping table in M2 (`status.ts` already carries the Open311 column) |
| E10 Equity | Block-group rollups, gap computation, public dashboard, inspection quota | missing | — | M2 (`block_group_stats`, `/equity`, silent zones → inspection task) |
| E11 Notifications | Push/SMS/voice, fatigue budget, quiet hours, i18n templates, delivery analytics | partial | Inbox screen and quiet-hours prefs exist; no push registration or delivery | M1 status push; M2 SMS (D11) + webhook delivery status; M4 fatigue budget + predictive. Voice **deferred** (§20.1); templates English only (D6) with the place-and-action rule instead |
| E12 Accessibility | Audit, screen-reader passes, dynamic type, VPAT | partial | Primitives carry 44 pt targets and labels; `SeverityBars` reads "High, 3 of 4"; the map list is the pin mirror; no audit run | Passes in M3 and M5 (T10, T11); VPAT **deferred** — `docs/accessibility.md` conformance notes (§20.1) |

## §20.1 Spec items deferred by owner decision

| Item | Spec | Status | Reason (plan §20.1) | When |
|---|---|---|---|---|
| Cityworks / Cartegraph sync | §14 Phase 1 | deferred | No vendor sandbox or credentials for the pilot; seam + status mapping built now | Phase 2 (D10) |
| Submit a report without any account | §11 Anonymous role | deferred | D3: accounts required for writes; anonymous *identity* remains, with unlinkability (AC19) | Revisit after pilot |
| Languages beyond English | §12 EN/ES/ZH/VI | deferred | D6 | Phase 2 |
| Voice alert channel | §5 Notify | deferred | SMS covers the degraded path; voice needs an IVR vendor | Phase 2 |
| Face / plate blur | §13 | deferred | Needs an on-device ML module; staff-only gate until triage instead (`faces_blurred` column ready) | Phase 2 |
| Address verification for voting | §4.3 | deferred | Participation vs integrity left to the city (D3) | Phase 2 |
| Full VPAT | E12 | deferred | `docs/accessibility.md` conformance notes in v1 | Phase 2 |

## §12 Non-functional requirements (v1-relevant)

| Requirement | Status | Evidence / gap | Decision |
|---|---|---|---|
| Offline-first capture, queue, retry surviving no-signal and app kill | partial | `drafts:v1`, `syncQueue` retry policy, screens test asserts zero fetch offline; no photo capture or upload yet | M1 end-to-end; T1–T5 on devices |
| WCAG 2.2 AA, screen reader, dynamic type to 200 %, no colour-only severity | partial | Tokens, primitives, `SeverityBars`, map list mirror | Widgets M1; audits M3 / M5 |
| Multilingual EN/ES/ZH/VI | deferred | English catalog only | D6 |
| Queue p95 < 400 ms at 200k reports | missing | — | M2 (`perf:queue`, `docs/perf.md`) |
| 99.9 % intake availability | partial | `/api/health` (version, db ping, jobs' last OK, quota usage; 503 when misconfigured) with a route test; no deploy and no uptime monitor yet | M0 open item (monitor on preview + production); measured, not contractual |
| Retention: photos 7 y, anonymous GPS coarsened at 30 d, audit log permanent | partial | Append-only triggers on `report_event`, `severity_audit`, `audit_log` in `0001_init.sql` (not yet asserted by `test:int`, which is a stub); `geo.snapToGrid` exists; no jobs | M2 `coarsenGps`, `purgePhotos`; stated in `docs/privacy.md` |
| Records law: labelled internal notes | missing | — | M2 (`is_internal`, labelled "still subject to records requests") |
| Procurement artefacts (SOC 2, VPAT, DPA) | deferred | — | §20.2 |

## Decisions carried into week 2 / M1

1. Close the remaining M0 items before any M1 screen work: Sentry wiring (app + routes, PII scrubbed), the first preview deploy and the uptime monitor on `/api/health`, `supabase db reset` + `npm run test:int` run once against Docker with real assertions in the stub, and the four spikes measured into `docs/runbook.md` §10–11 (MapLibre dev clients, R1 upload on EAS Hosting, backup dry run, 10DLC submission). Migrations, `/api/health`, memory + Supabase repos, JWT verify, CI and the formula-derived domain tests are in; `npm run typecheck` and `npm test` are green.
2. Decide on `src/i18n` (keep the typed catalog, which plan §3.9 adopts, or inline literals as plan §2 / §5 say) and align the plan.
3. Commission RootCause icon and splash artwork; until then the build carries the sibling placeholder and must not be submitted for review.
