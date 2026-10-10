# Gap analysis — repository vs. the spec

Spec: `../docs/3_NewJersey_2.HTM` (RootCause prototype v0.9, handoff §1–§17). Plan: `docs/plan.md` (rev 4; §23 supersedes earlier text). This file is re-written at the end of every milestone and lists every spec row the resident app needs with done / partial / missing before release (plan §15 M5).

Snapshot: **2026-10-10, end of the owner's "finish the app" run** (ultragoal `.omc/ultragoal/goals.json`, story G001). The owner's brief of 2026-10-09 sets the scope: the resident app must be fully working and demo-able against the live backends (every key is in `.env`); the DPW console / admin views are out of scope for this run and are listed only for completeness. Evidence was re-checked against the tree at the end of the run: `npx tsc --noEmit` clean, `npx expo lint` clean, `npx jest` 48 suites / 462 tests green, `scripts/e2e-check.ts` 23/23 against the dev-memory server with real Supabase Auth sessions and a live Claude call, and a screenshot pass of every resident screen on the iOS Simulator (Expo Go).

Status key: **done** · **partial** (exists, but a named piece is missing) · **missing** (not built) · **deferred** (not in v1 by owner decision, with the reason) · **excluded** (console/admin, out of this run's scope).

## Headline gaps at the start of the run — and where they stand at its end (2026-10-10)

| # | Gap found by the audit | Status at the end of the run | Evidence |
|---|---|---|---|
| 1 | Vision was a stub | **done** | `src/server/vision.ts` calls Claude Haiku 4.5 with structured output; live check `npm run vision:check` (pothole 0.95, root heave 0.92, street scene unclear) and on the simulator from the intake flow; `__tests__/server/vision.test.ts`; corrections stored as `vision_feedback` at report creation |
| 2 | Status changes were a 501 | **done** | `PATCH /api/v1/reports/:id` (staff), `src/server/lifecycle.ts`, `scripts/set-status.ts`; status pushes fire from `notifyStatusChange()` |
| 3 | No resident verification | **done** | `POST /api/v1/reports/:id/verify`, S-08 "Is it fixed?" card, two confirmations → verified, a photo rejection reopens one band higher, demo `verify` scenario works locally |
| 4 | No predictive alert loop | **done** | `weatherPoll` (NWS), `scenarioEval` (rain / wind / freeze rules, fatigue budget, quiet hours, cooldown), `alertDispatch` (20 pushes per tick), `GET /api/v1/me/alerts`, inbox chips, S-09 briefing, `scripts/demo-storm.ts`; the demo storm scenario drives the same screens offline |
| 5 | Home had no hero / "How is this scored?" | **done** | Predictive-alert card on Home, "Map view" and "How is this scored?" rows, `/why` index screen |
| 6 | Analysis showed no exposure / ADA | **done** | `AnalyzeResponse.exposure / adaRelevant / address`; S-05 "Where this is" group |
| 7 | Profile stats, export, median | **done** | `GET /api/v1/me` stats, "Export my data" → share sheet (JSON), median time to resolve on own reports |
| 8 | Phone verification / SMS | **done (switched off by env)** | Twilio Verify start/check routes, S-11 phone group, `server/sms.ts` claim rows, status-change SMS leg, delivery webhook; `SMS_ENABLED=false` until 10DLC |
| — | Found while rehearsing on the simulator | **done** | Expo Go crash from the offline-map import (guarded); onboarding category labels; truncated filter chips; key-value rows without padding; the Home sort control squeezed into 24 pt; sign-in link hardening (PKCE, raw tokens refused, pending-sign-in gate); modal stacking after the e-mail link; React Native FormData uploads failing on device (hand-framed multipart); documented `?demo=` / `map?cat=` deep links implemented; dev-memory server completed (`me`, `engagement`, jobs store, rate limiter on `globalThis`) with `ROOTCAUSE_DEV_STAFF` and `ROOTCAUSE_DEV_SESSION` seams |

Still open for the owner (nothing in the tree can do these): apply the Supabase schema (`npm run db:push` with `SUPABASE_DB_URL`), configure SMTP for the e-mail code (Supabase's built-in sender allows two e-mails an hour and refuses reserved domains — the simulator rehearsal used the developer sign-in seam), Apple / Google credentials, a development build (CocoaPods or EAS) for the map, `JOB_SECRET` + `app_settings.job_url` for the real job tick.

## §3 Resident app (R1–R14) and the plan's extra screens

| Spec | Screen | Status | Evidence / gap |
|---|---|---|---|
| R1 | Home / risk feed | done | `(tabs)/index.tsx`: open-hazard index with named drivers (labelled "what has been reported, weighted by score — not a prediction"), the active predictive-alert card ("See the spots" / "Open alerts"), "Map view" and "How is this scored?" rows (`/why`), ranked queue with urgency / distance / newest sort, category filter, inline vote with the sign-in callout, barometer, pull-to-refresh through `GET /api/v1/reports` |
| R2 | Map + heatmap | done | `(tabs)/map.tsx` + `ui/HazardMap*.tsx`: MapLibre with the bundled OpenFreeMap style, clustering, severity-coloured pins sized by votes, peek card, category filter, list mirror, offline pack (S-12). Expo Go shows the "needs a development build" line instead of a crash. Heat layer and tree layer **deferred** (no incident model, no inventory; spec E8 "heat must be modelled risk, not report density") |
| R3 | Capture | done | `new/index.tsx`: camera + library, draft on disk before anything else, re-encode ≤ 1280 px + 320 px thumbnail, EXIF dropped on device (and again on the server, `server/exif.ts`), spot confirmation for library photos, sign-in asked at the first upload (§23.A), upload → analyze → S-05. Live on-device detector **deferred** (spec E2: "the flow must work without it") |
| R4 | AI analysis | done | `new/analysis.tsx`: the uploaded photo, the Claude proposal with its confidence or the honest unclear / off / offline / timeout line, the "Where this is" group (address, pedestrians per day with school-route / senior-facility / transit flags, ADA line), duplicates within the sub-type radius with "Add to that report" (photo attach = vote). Species **deferred** (Phase 3); asset id **deferred** (no inventory) |
| R5 | Report form | done | `new/form.tsx`: prefill from a confident proposal, category / sub-type always correctable, "how dangerous right now", "has anyone been hurt", location text, note, identity on the report, save draft, submit (offline → queued; signed out → parked as needs_sign_in). **Missing (small):** a correction label to `vision_feedback` when the resident changes the proposed category / sub-type (spec 4.1 "every correction is a training label"; table exists, no route) |
| R6 | Submitted / score | done | `new/submitted.tsx`: the five weighted terms, rank among the open orders of the category (computed on the phone, labelled), SLA stages for the band, share, back to feed; the "not sent yet" state is honest |
| R7 | Report detail | partial | `report/[id].tsx`: evidence, note, vote with threshold, five-term score, timeline, comments (public record), nearby related orders, share, follow, flag, the "Is it fixed?" card on `completed` reports (confirm / still a hazard); everything optimistic and queued offline; a live report opens by id even while a demo scenario is on. **Missing:** "add a photo to this report" from the detail screen (only reachable from S-05), so a rejection from the phone cannot carry the photo that reopens the order |
| R8 | Alerts inbox | done | `(tabs)/alerts.tsx`: server alerts from `GET /api/v1/me/alerts` merged with the push mirror, All / Weather / Status chips, the labelled storm advisory while the demo runs, every alert names a place and an action, "Edit alert rules" cell, real empty state; a push tap opens `/report/[id]` or `/alert/[id]` |
| R9 | Alert detail / briefing | done | `alert/[id].tsx`: why you got this, the forecast terms, the specific spots, what the city is doing, back to alerts; a push mirror without the briefing says so until the server copy arrives |
| R10–R12 | Plants hub, scan result, pollen outlook | deferred | Spec Phase 2/3 (§14); owner decisions kept (plan §20.1) |
| R13 | Profile / impact | done | `(tabs)/me.tsx`: impact framing from `GET /api/v1/me` stats (reports filed, resolved, urgency votes cast, median time to resolve), signed-out state, my reports incl. drafts and failed sends (both open the form), "Export my data" through the share sheet, links to settings / data / privacy. Trust score **deferred** (§20.2) |
| R14 | Settings / alert rules | done | `settings.tsx` (quiet hours, phone verification through Twilio Verify, SMS opt-in, sign out, delete my data per §23.C, staff sign-in) + `watch-areas.tsx` (home / work / route / custom, radius, categories, mirrored to the account). SMS sending stays off until `SMS_ENABLED=true` (10DLC). Allergy sensitivities **deferred** (allergen module, Phase 3) |
| — | S-00 Onboarding | done | `onboarding.tsx`: home area, categories, quiet hours; no sign-in (D3) |
| — | S-12 Offline data | done | `data.tsx`: saved data, drafts, simulate offline, demo scenarios, low-storage notice, map pack, reset |
| — | S-13 Privacy / Terms | done | `privacy.tsx`, `terms.tsx` (public; SMS program language for 10DLC). Legal review pending (D12) |
| — | S-14 Sign-in | partial | `sign-in.tsx` + `auth/callback.tsx`: Apple, Google, email code; draft survives. **Open:** the Google iOS URL scheme plugin was removed from `app.json` pending the owner's iOS client id — Google sign-in on iOS needs it back (the id is now in `.env`) |
| — | `/why/score/[id]` | done | Real constants next to this report's terms |
| — | `/why/index` | done | `why/index.tsx`: the open-hazard index definition, the live terms (index, reports counted, radius, measured from), the drivers, which statuses count as open |
| — | `/r/[id]` | done | Public share page through `toPublicReport()` |

## §4 Core flows

| Flow | Status | Evidence / gap |
|---|---|---|
| 4.1 Report flow (60-second promise) | done | End to end offline-first: capture → draft on disk → upload → analyze (Claude proposal, exposure, duplicates) → form → submit → score → rank; a photo the server no longer knows is re-uploaded once (`unknown_photo`) |
| 4.2 Predictive alert flow | done | `weatherPoll` (NWS hourly → `weather_forecast`), `scenarioEval` (rain / wind / freeze rules, fatigue budget, quiet hours, cooldown; the rain window from the wettest six hours), `alertDispatch` (pushes with `alertId`), inbox + briefing; `scripts/demo-storm.ts` and the `storm` demo scenario drive the same screens |
| 4.3 Vote / barometer flow | done | `POST/DELETE /api/v1/reports/:id/votes`: one per account, weight from `domain/votes`, 1.5 km geo check flags `unverified_geo`, community term recomputed, 25 / 100 thresholds notify (`__tests__/routes/engagement-notify.test.ts`) |
| 4.4 Verification flow | done | `POST /api/v1/reports/:id/verify` + the S-08 card: one verdict per account per completion, two confirmations → verified, a rejection with the resident's own new photo reopens to `assessed` one band higher (audited, followers pushed); `autoVerify` after 14 days of silence counts only verdicts of the current completion. Crew after-photo scoring and the supervisor notice are console work (excluded) |

## §10 API surface (resident-relevant)

| Route | Status | Note |
|---|---|---|
| `POST/GET /v1/reports`, `GET /v1/reports/:id` | done | bbox / category / status / sort, idempotent by `clientDraftId`, `toPublicReport()` |
| `PATCH /v1/reports/:id` | done | Staff capability, `domain/status.transition()`, `report_event`, after-photo required for `completed`, `notifyStatusChange()` (push + SMS leg) |
| `POST/DELETE /v1/reports/:id/votes`, `POST …/comments`, `POST …/follow`, `POST …/flag`, `POST …/photos`, `POST /v1/comments/:id/flag` | done | Route tests in `__tests__/routes/` |
| `POST /v1/reports/:id/verify` | done | Headline 3; `src/server/lifecycle.ts` |
| `POST /v1/vision/analyze` | done | Claude Haiku 4.5 structured output, per-user and per-tenant daily budgets, duplicates, exposure / ADA / address in the response |
| `POST /v1/vision/feedback` | done (folded in) | No separate route: `POST /v1/reports` records the correction (`vision_feedback`) when the submitted sub-type differs from the proposal for the photo it attaches |
| `GET/PATCH/DELETE /v1/me`, `GET /v1/me/reports`, `GET /v1/me/export`, `/v1/me/watch-areas`, `POST /v1/me/devices`, `POST /v1/me/apple-link` | done | |
| `GET /v1/me/alerts` (+ mark read) | done | `me/alerts+api.ts`, `me/alerts/[id]/read+api.ts` |
| `POST /v1/me/phone`, `POST /v1/me/phone/check` | done | Twilio Verify start / check; `SMS_ALLOWLIST` + `tenant.sms_enabled` gates; delivery webhook under `api/webhooks` |
| `GET /api/health`, `POST /api/jobs/tick` | done | Jobs: recompute, coarsenGps, purgePhotos, autoVerify, pushReceipts |
| Open311 / Cityworks / exports / ops | excluded | Console and integrations (not needed to demo the resident app; Cityworks deferred by D10) |

## §17 Build backlog (E1–E12), resident view

| Epic | Status | Evidence / gap |
|---|---|---|
| E1 Foundations | done | Supabase schema (`0001_init.sql`, `0002_me.sql`), RLS + security-definer RPCs with explicit revokes, append-only triggers, JWKS auth, structured PII-masking logs, DB-backed rate limits, CI workflow. Open: the migration must be applied to the live project (checked in G005) |
| E2 Capture | done | Camera, offline queue, photo pipeline (resize, EXIF strip on device and server, staff-only until release) |
| E3 Analysis | done | Duplicates (PostGIS), exposure (bundled OSM extract: 2,499 roads / 152 POIs / 5,469 addresses), ADA flag from the taxonomy at insert, severity proposal from Claude with corrections stored |
| E4 Report lifecycle | done | State machine + timeline + comments, staff status route, resident verification, reopen one band higher, auto-verify scoped to the current completion |
| E5 Scoring | done | Five terms at insert, nightly recompute, `/why/score/[id]`, formula oracle tests. Weight admin UI excluded (console) |
| E6 Voting | done | Endpoints, weights, geo flag, thresholds; anomaly flags "simple v1" in the nightly job |
| E7 Console | excluded | Owner brief 2026-10-09 |
| E8 Map | done | MapLibre, clustering, offline pack; heat deferred |
| E9 Integrations | partial / excluded | Weather poll missing (headline 4); Open311 / Cityworks / GIS excluded |
| E10 Equity | excluded | Console dashboard; the per-capita normalisation already lives in `domain/score` |
| E11 Notifications | done (SMS switched off by env) | Push registration, status trigger + copy, quiet hours, receipts job, predictive alerts with the fatigue budget, inbox + briefing, SMS leg through `sms_message` claim rows behind `SMS_ENABLED` |
| E12 Accessibility | partial | 44 pt targets, labels, severity read as words, map list mirror; dynamic type checked at XXXL on the simulator (Home, detail). VoiceOver pass T10 still to run on a device |

## §12 / §13 Non-functional and privacy (v1-relevant)

| Requirement | Status | Evidence / gap |
|---|---|---|
| Offline-first capture, queue, retry | done | `drafts:v1`, `syncQueue`, zero-fetch-offline screen tests, `__tests__/services/syncQueue.test.ts` |
| Accessibility (WCAG 2.2 AA, no colour-only severity, dynamic type) | partial | Widgets comply; dynamic type checked at XXXL on the simulator; VoiceOver device pass pending |
| Multilingual | deferred | D6 English only |
| Retention (photos 7 y, anonymous GPS coarsened at 30 d, audit permanent) | done | `coarsenGps`, `purgePhotos`, append-only triggers |
| Photo privacy (EXIF, staff-only until release) | done | Face / plate blur deferred (on-device ML; `faces_blurred` column ready) |
| Public map jitter, anonymous identity, no watch-area exposure | done | `geo.publicPoint`, `toPublicReport()`, anonymous reports unlinkable (§23.D) |
| Availability / monitoring | partial | `/api/health`; no uptime monitor yet |

## Console (O1–O12)

Excluded from this run by the owner's brief (2026-10-09). Nothing under `src/app/console/` exists; `scripts/grant-role.ts` grants the first director; `PATCH /v1/reports/:id` (headline 2) is the one staff-only piece this run adds because the resident timeline, alerts and verification cannot be demonstrated without a status change — a CLI script stands in for the console during the demo.
