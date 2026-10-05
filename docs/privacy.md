# RootCause privacy notice

> **DRAFT — not yet reviewed by the city attorney.** Bracketed items `[legal: …]` need a decision before launch (plan §12, §15 M5, owner decision D12). This text is rendered on the phone at `/privacy` (S-13) and on the web at `/privacy`.

Last updated: 2026-10-05 (draft) · Operator: `[legal: City of New Brunswick, Department of Public Works, or the pilot entity]` · Contact: `[privacy contact email]`

## In one paragraph

RootCause is a way to report a hazard on public property — a lifted sidewalk, a hanging limb, a pothole, a blocked drain, a dark street light — and to be warned about hazards near you. What you report is a public record. Your identity, your home area and your phone number are not. This notice says exactly what leaves your phone, what the public sees, what the city keeps and for how long, and what you can delete.

## What we collect, and why

| Data | When | Why | Who can see it |
|---|---|---|---|
| Sign-in identity (Apple or Google account id, or your email address) and a display name | When you first vote, comment, follow or submit a report. Browsing needs no account. | One vote per person; your reports stay yours | City staff with a role; never other residents |
| Report: photo, category and sub-type, your two answers ("how dangerous right now?", "has anyone been hurt?"), location, the approximate address, an optional note, your identity choice (Named / Initials / Anonymous) | When you submit | To create and rank a work order | Public, after the photo is released by an inspector (see Photos); see "What the public sees" |
| Votes, comments, follows, verifications | When you make them | They move the priority score and tell you about status changes | Vote counts and public comments are public; who voted is not |
| Watch areas (home, work, a route, a custom radius) | Only if you save one | To decide which alerts you get | Never shown to anyone; used only to select alert recipients |
| Your home area from onboarding | Chosen on the phone | Ranking nearby reports | Stays on your phone unless you save it as a watch area |
| Approximate location when you vote | At the moment of the vote, if you allow location | To mark votes from far outside your watch area as `unverified_geo` (they still count) | Staff only, as a flag; the coordinates are not kept |
| Phone number | Only if you opt in to SMS and confirm a 6-digit code | Text alerts when push cannot reach you | Never shown; stored in E.164 form; the code is stored hashed |
| Push token | After your first follow, vote or report | Status and alert notifications | Server only |
| Install id | Every request | An extra rate-limit dimension against abuse | Server only; never in any public response |
| Crash and error reports (Sentry) | On errors | To fix bugs | Engineering; personal data is scrubbed before sending; there is no product analytics |

We do not collect immigration status, health data, contacts, or precise location in the background. Location is read when you capture a photo, when you vote, and when you ask the map to centre on you.

## Photos

- What you see on the Analysis screen is exactly what uploads. The phone resizes the photo to at most 1280 px and removes all camera metadata (EXIF, including GPS); the server removes it again.
- Keep faces, licence plates and house interiors out of frame. Version 1 does not blur them automatically, so every photo is visible to city staff only until an inspector releases it at triage. Staff can hide a photo; you can flag one; `[privacy contact email]` handles takedown requests.
- When vision assist is on, your photo and the report's coordinates are sent from our server to Anthropic's API (model Claude Haiku 4.5) to propose a category and sub-type. The proposal and its confidence are stored with the photo. Your correction is stored as a training label for a future model; nothing is trained in v1. You can turn the assist off in Settings; the report works identically without it.
- Photos are stored in a private bucket and served through short-lived signed links.

## What the public sees

Anyone, with or without an account, can see on the map, in the feed, on the public web page `/r/<id>`, in Open311 and in exports: the category, sub-type, status and status history, the priority score and its five terms, the approximate address, released photos, public comments, the vote count, and the reporter display you chose:

- **Named** — your display name.
- **Initials** — your initials.
- **Anonymous** — no name. The server stores no link between the report and your account (no reporter id, no uploader id on its photos, no follow or vote row). Only your phone remembers it is yours, so it appears in "My reports" on that phone and nowhere else. Because the link does not exist, Anonymous reports cannot receive status updates.

Location on the public map: a report linked to your account is shown at a point snapped to a 50 m grid and shifted deterministically, so the exact spot is not published. An Anonymous report is shown at its real location until day 30, after which the stored location itself is coarsened to 50 m and the raw GPS is deleted.

Never public: who voted, your email, your phone number, your watch areas and home area, your install id, staff internal notes (see Public records), unreleased photos, the exact point of an account-linked report.

## Public records

Everything you submit to the city — reports, photos, comments, the status history — is a public record and may be released under New Jersey's Open Public Records Act or other law. `[legal: confirm OPRA treatment of resident identity fields]`. Staff "internal notes" are labelled in the app as still subject to records requests. By submitting a photo you license it to the city as described in the [terms](terms.md); the city may release it under records law `[legal: D12 — confirm before launch]`.

## How long we keep things

| What | How long | Why |
|---|---|---|
| Reports, photos, status events, comments | 7 years | Evidence for claims and audits (spec §12) |
| Anonymous report GPS | Precise for 30 days, then coarsened to 50 m; raw GPS deleted | Spec §12 |
| Audit log, severity audit, status events | Permanent, append-only (the database refuses updates and deletes) | Accountability |
| Photos you uploaded but never attached to a report | Deleted after 24 hours | — |
| SMS verification codes | 10 minutes, stored hashed | — |
| Rate-limit counters | Hourly windows keyed by a hash of your account; no report ids | Abuse control |
| Push tokens | Dropped when the device stops accepting pushes | — |
| Backups | Nightly, encrypted, kept 35 days in a separate bucket | Supabase's free tier has no backups of its own |

## Delete my data

Me → **Delete my data** de-identifies you: your account is deleted from sign-in, your reports lose their link to you (they become Anonymous), your comments are attributed to "former user", and your devices, phone number, watch areas and the identity on your votes are removed. The reports, photos and status history themselves stay, as public records, for the retention period above. Me → **Export my data** gives you a copy first (up to twice a day). Deletion completes within `[legal: N days]` including backups.

## Notifications and SMS

Push notifications tell you about status changes on your own and followed reports and, in a later release, about storm advisories. You get at most two predictive alerts (push or SMS) in any 7 days; quiet hours you set are respected; only an emergency alert approved by the public-works director breaks both rules.

SMS is opt-in and needs a verified number. You receive SMS only for warning or emergency alerts, and for status changes when no phone of yours accepts push. Messages come from the RootCause program number; message frequency varies; message and data rates may apply; reply **STOP** to stop and **HELP** for help. Full SMS terms are in the [terms](terms.md).

## Who processes your data

Supabase (database, sign-in, photo storage) · Expo / EAS (hosting of the server routes, push notifications) · Anthropic (vision assist, only when on) · Twilio (SMS) · Resend (email to staff and, for emergencies, to you) · Sentry (error reports, scrubbed) · OpenFreeMap (map tiles — your phone requests tiles directly, so the tile server sees your IP address and the area you are viewing; the offline map pack avoids this) · National Weather Service (forecasts, fetched by our server only). `[legal: data-processing terms with each vendor; data location]`

## No sharing with enforcement agencies

Reports are about public property, not people. We do not collect immigration status. We do not share reporter identities, phone numbers, locations or watch areas with immigration or law-enforcement agencies, and we do not sell or share any of it with advertisers. `[legal: state the position on court orders and records requests that name a reporter]`

## Children

RootCause is not directed at children under 13. Sign-in is through Apple, Google or an email address `[legal: age gate and COPPA position]`.

## Changes and contact

Changes to this notice are listed here with the date; material changes are announced in the app. Questions, takedown requests and records questions: `[privacy contact email]`, `[postal address]`.

## Text messages (SMS program)

RootCause sends text messages only to a phone number you add and verify yourself in Me → Alert rules. Messages are status updates on reports you filed or follow, weather advisories for your watch areas (at most two predictive alerts per week), and emergency notices. Message frequency varies with activity near you. Message and data rates may apply. Reply STOP to opt out at any time, or HELP for help. We do not share, sell, or provide your mobile phone number or messaging consent data to third parties or affiliates for marketing or promotional purposes. Carriers are not liable for delayed or undelivered messages.
