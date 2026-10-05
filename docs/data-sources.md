# Data sources (evidence trail)

Every bundled or fetched dataset the app ranks, maps or warns with, where it came from, under which licence, how it is fetched, and what it is allowed to claim. Fill in the **read date** and the **row counts** the day a build script runs; a reviewer should be able to re-run the script and get the same file. Pilot area: New Brunswick, NJ (owner decision D1; `EXPO_PUBLIC_PILOT=new-brunswick-nj`).

Status at M0: skeleton — no extract has been built yet. Rows marked `[fill]` are completed by the script run that produces the file.

## 1. OpenStreetMap extract — exposure proxy and approximate addresses

| | |
|---|---|
| File | `assets/data/osm/new-brunswick-nj.json` |
| Script | `scripts/build-osm.ts` (M1) — Overpass API query, deterministic output (sorted ids), clipped to the pilot bbox |
| Source | OpenStreetMap via Overpass (`https://overpass-api.de/api/interpreter`); `User-Agent: RootCause-build/1.0 (<contact>)` |
| Licence | © OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright. The extract is a derivative database and remains under ODbL; attribution is shown on the map, in Offline data and in the README |
| Bbox | `[fill]` — the TIGER place boundary of New Brunswick city, buffered 500 m; approximate extent minLng −74.49, minLat 40.46, maxLng −74.40, maxLat 40.53 (confirm from the TIGER polygon when `build-census.ts` runs) |
| Read date | `[fill]` · Overpass data timestamp `[fill]` |
| Row counts | roads `[fill]` · address points `[fill]` · schools `[fill]` · senior facilities `[fill]` · transit stops `[fill]` |

What is pulled (plan §8):

| Feature | Overpass selector | Used for |
|---|---|---|
| Roads with class | `way[highway]` with `highway` in primary, secondary, tertiary, residential, living_street, footway, pedestrian, path, service, motorway, trunk; name kept | Pedestrians/day lookup (below); snapping a report to the nearest road when no address point is near |
| Address points | `node["addr:housenumber"]` and building centroids with `addr:housenumber` | Approximate reverse-geocoding ("near 112 Somerset St", labelled approximate; `address_confidence = approx`) |
| Schools | `amenity=school` (nodes and way centroids) | Vulnerability multiplier +0.15 within 200 m |
| Senior facilities | `social_facility=nursing_home` or `social_facility=assisted_living` | +0.15 within 200 m |
| Transit stops | `highway=bus_stop`, `railway=station`, `railway=tram_stop` | +0.10 within 200 m |

Pedestrians/day per road class — **placeholders**, not counts (plan §8, labelled "estimated from map data" in the app):

| Road class | Pedestrians/day |
|---|---|
| primary | 4000 |
| secondary | 2500 |
| tertiary | 1500 |
| residential | 600 |
| living_street | 400 |
| footway / pedestrian | 1200 |
| path | 200 |
| service | 150 |
| motorway / trunk | 0 |

`exposureTerm = min(1, log1p(peds) / log1p(5000)) × vulnMult`, `vulnMult = 1 + .15 school + .15 senior + .10 transit + .10 adaRoute (0 in v1)`, capped at 1.4. Replace the table with the city's pedestrian counts when the pilot provides them; the term's label changes from "estimated from map data" to the count's source and date.

## 2. Census block groups — denominators for equity

| | |
|---|---|
| Files | `assets/data/block-groups.json` (geometry, simplified), `assets/data/wards.json`; server table `block_group` loaded by the same script |
| Script | `scripts/build-census.ts` (M2) |
| Geometry | TIGER/Line Shapefiles, block groups, New Jersey (state FIPS 34), Middlesex County (county FIPS 023), vintage `[fill, e.g. 2024]` — https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html |
| Attributes | ACS 5-year estimates, vintage `[fill]`: `B01003_001E` total population, `B19013_001E` median household income, by block group — Census Data API `https://api.census.gov/data/<year>/acs/acs5` |
| Wards | City council ward boundaries from `[fill: city GIS or county open-data portal URL]`; if none is published, wards are derived by assigning block groups to the city's ward list by hand and the file says so |
| Licence | Public domain (U.S. federal government work). ACS values are estimates with margins of error; the app shows them as denominators only |
| Read date | `[fill]` · block groups `[fill]` · population total `[fill]` |

Derived nightly (`rollup_block_groups()`, plan §6): `reports_per_1k`, `median_days_to_close`, `open_hazard_index` (percentile rank 0–100 across the tenant's block groups of Σ score of open reports per 1k residents), `reporting_pct`, `index_pct`, `gap = index_pct − reporting_pct`. Block groups with population below 50 are shown without per-capita figures to avoid noise `[confirm threshold in M2]`.

## 3. NWS gridpoint forecast — storm scenarios (M4)

| | |
|---|---|
| Table | `weather_forecast` (server), one row per poll; demo copy `assets/data/demo/forecast-storm.json` |
| Job | `weatherPoll` every 15 min (`src/server/jobs/weatherPoll.ts`), `User-Agent` from `NWS_USER_AGENT`, 10 s timeout |
| Endpoints | `https://api.weather.gov/points/{lat},{lng}` once at setup → `gridId`, `gridX`, `gridY` `[fill]` for the pilot centroid; then `https://api.weather.gov/gridpoints/{gridId}/{gridX},{gridY}` every poll |
| Fields | `quantitativePrecipitation` (mm, summed over the scenario window), `probabilityOfPrecipitation` (used as `forecast.confidence` for rain scenarios; absent for wind / freeze), `windGust` (km/h), `temperature` min / max (freeze–thaw) — plus `validTime` ISO-8601 duration strings parsed to `valid_from` / `valid_to` |
| Licence | Public domain (NWS). Attribution "Forecast: National Weather Service" on scenario cards |
| Staleness | Badge when the newest row is older than 60 min; scenarios evaluate only on forecasts younger than 60 min (plan R12) |
| Demo forecast | `[fill]` — an archived gridpoint response for a real heavy-rain day in the pilot area, with `validTime` shifted to "tonight" by the demo clock; labelled "demo" wherever it appears |

## 4. Reference tables from the spec

| File | Source | Note |
|---|---|---|
| `assets/data/taxonomy.json` / `src/domain/taxonomy.ts` | Spec R5 sub-type picker and mock data | 5 categories, 17 sub-types, sensitivity tags, ADA relevance, linear flag; `docs/taxonomy.md` (M1) explains each |
| `assets/data/sla.json` | Spec O10 SLA matrix | Prose cells made numeric: Next cycle = 90 d, 1 season = 120 d, Bundled = 365 d (plan §6) |
| `assets/data/remediation-options.json` | Spec O3 remediation ladder | Unit costs and recurrence months are the spec's placeholders ("plausible placeholders … must be replaced with the pilot city's own numbers") and are shown as reference only |
| Score weights and constants | Spec §7 | `.32 / .24 / .22 / .14 / .08`, bands `.25 / .5 / .78 / 1`, storm multiplier 1.0–1.6, vulnerability multiplier cap 1.4. Pilot defaults the spec does not give (plan §6, §8): `k = 0.25`, active-user floor 20, near-miss weight 0.5 |

## 5. Map tiles (not bundled)

OpenFreeMap `liberty` style — `https://tiles.openfreemap.org/styles/liberty` — rendered from OpenMapTiles / OpenStreetMap. No key, no SLA; fetched by the phone and the console directly. Attribution "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors" is always visible. Optional offline pack: zoom 11–15 over the pilot bbox, size measured in M1 `[fill MB]`. Fallback: Protomaps PMTiles extract on Cloudflare R2 behind our own `style.json` (`EXPO_PUBLIC_MAP_STYLE_URL`).

## 6. Demo data

`assets/data/demo/reports.json` — fabricated reports over real New Brunswick streets, generated by `scripts/seed-demo.ts` with deterministic seeds (`fnv1a`), every record `isDemo: true` and labelled on screen. No real resident, report or incident is depicted. The spec's "City of Elmwood" and all prototype figures are fictional.

## What the app does not claim

- **Pedestrian counts.** The exposure term is an estimate from road class and nearby facilities, labelled as such; no count is published for the pilot area.
- **A risk prediction.** The open-hazard index is "what has been reported, weighted by score — not a prediction"; storm scenarios are rules joining the NWS forecast to open reports' sensitivity tags, labelled "rules-based: forecast × open backlog". There is no incident or recurrence model in v1.
- **Measurements from photos.** The vision assist proposes a category and sub-type with a confidence; it never outputs a displacement, a millimetre value, a species "at quality", or an emergency on its own.
- **Exact addresses.** Addresses are the nearest bundled OSM address point or road, shown as approximate and editable by the resident.
- **Exact locations of reporters.** Public points for account-linked reports are snapped and jittered; home areas and watch areas are never published.
- **Census precision.** ACS figures are 5-year estimates with margins of error, used as denominators only.
- **Map availability.** Tiles come from a third party without an SLA; pins and reports work without them.
- **Weather.** Forecasts are the NWS's; the app adds thresholds, not skill. Stale forecasts are flagged and never used for a scenario.
- **Verification of fixes.** "Fix confirmed by a resident" means two confirmations or 14 days of silence (auto-verify), and the timeline says which.
