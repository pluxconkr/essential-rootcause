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
| Bbox | `PILOT_BBOX` (`src/domain/pilot.ts`: 4,000 m around 40.4862, −74.4518) = minLng −74.4990, minLat 40.4503, maxLng −74.4046, maxLat 40.5221 — covers the city plus the edge of Highland Park, Piscataway, Edison, North Brunswick and Franklin. Switch to the TIGER place boundary buffered 500 m when `build-census.ts` runs (M2) if the wider box skews the exposure proxy |
| Read date | 2026-10-05 (`fetchedAt` 2026-10-05T15:27:46Z) · Overpass data timestamp 2026-10-05T15:26:20Z |
| Row counts | roads 2,499 (named ways; residential 1,707 · tertiary 338 · secondary 264 · service 64 · path 42 · unclassified 38 · primary 28 · footway 8 · living_street 7 · pedestrian 3) · address points 5,469 (unique per street + number) · schools 48 · senior facilities 4 · transit stops 100 · file 817 KB |

What is pulled (plan §8):

| Feature | Overpass selector | Used for |
|---|---|---|
| Roads with class | `way["highway"~"^(primary\|secondary\|tertiary\|residential\|living_street\|footway\|pedestrian\|path\|service\|unclassified)$"]["name"]` — every third node kept (plus first and last), vertices may run 250 m past the bbox so edge segments stay whole; motorway/trunk are not pulled (no pedestrians, never a sidewalk report) | Pedestrians/day lookup (below) by distance to the nearest road *segment*, within 100 m; the road name in "<road> near <cross street>" when no address point is near |
| Address points | `node["addr:housenumber"]["addr:street"]` and way centres with both tags; one point per (street, number) | Approximate reverse-geocoding ("286 George Street", labelled approximate; `address_confidence = approx`; nearest within 75 m, same street preferred) |
| Schools | `amenity=school` (nodes and way centres) | Vulnerability multiplier +0.15 within 200 m |
| Senior facilities | `social_facility=nursing_home` or `social_facility=assisted_living` | +0.15 within 200 m |
| Transit stops | `highway=bus_stop`, `railway=station`, `railway=tram_stop`, `public_transport=platform` | +0.10 within 200 m |

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
| unclassified | 400 |
| motorway / trunk | 0 |
| no named road within 100 m | 200 (treated as a path) |

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

## 7. Offline map pack — M1 measurement (2026-10-06)

Supersedes the "zoom 11–15 … `[fill MB]`" line in §5 (plan §23.F fixed the pack at zoom 11–14). The pack is one MapLibre offline region (`OfflineManager.createPack`, `@maplibre/maplibre-react-native` 11.5) over the pilot bbox (`PILOT_BBOX`: the pilot centre ± 4 km, ≈ 8 × 8 km) downloaded from the remote style `EXPO_PUBLIC_MAP_STYLE_URL` (OpenFreeMap `liberty`), while the map view renders the bundled snapshot `assets/map/style.json` (`scripts/fetch-map-style.ts`, `metadata._fetchedAt`). Tiles, glyphs and sprites are keyed by URL in MapLibre's offline database, so the region serves both.

Measured by fetching every resource the region needs (scratch script, not committed; sizes as served):

| Resource | Count | Size |
|---|---|---|
| Vector tiles z11 | 1 | 0.10 MB |
| Vector tiles z12 | 4 | 0.30 MB |
| Vector tiles z13 | 9 | 0.42 MB |
| Vector tiles z14 | 25 | 1.39 MB |
| **Tiles total** | **39** | **≈ 2.2 MB** (1.5 MB on the wire, gzip) |
| Sprites (`ofm_f384/ofm` 1× + 2×, JSON + PNG) | 4 | 0.22 MB |
| Glyphs, non-ideographic ranges (Latin, Greek, Cyrillic, symbols …) | ≈ 50 ranges × 3 font stacks | ≈ 3.4 MB per stack, ≈ 10 MB |
| Glyphs, ideographic ranges (CJK, Hangul, kana) | ≈ 206 ranges × 3 font stacks | ≈ 31 MB per stack, ≈ 93 MB |
| **Pack total as MapLibre Native downloads it today** | | **≈ 105 MB** |

Why the fonts dominate: for an offline region MapLibre Native requests **all 256 glyph ranges of every font stack the style uses** (`offline_download.cpp`, `GLYPH_RANGES_PER_FONT_STACK`), and the liberty style uses three stacks (`Noto Sans Regular`, `Noto Sans Bold`, `Noto Sans Italic`) whose OpenFreeMap glyphs cover CJK. `@maplibre/maplibre-react-native` 11.5 leaves `includeIdeographs` / `includesIdeographicGlyphs` at their defaults (true) on both platforms and exposes no option for it. The result is under the plan's hard cap (150 MB) but far above its ≈ 12–15 MB expectation, and shrinking the zoom range would not help (the tiles are 2 MB). S-12 shows "about 105 MB" before the download and downloads over Wi-Fi only. Ways down to ≈ 6–12 MB, for the owner to pick: (a) point the pack at a style with one font stack and a glyph server that serves only non-ideographic ranges — the fallback bundle on R2 that plan §23.F already describes ("copies of the liberty style, non-ideograph glyph ranges and sprites") — or (b) a MapLibre RN option/patch that passes `includeIdeographs = false` (Android `OfflineTilePyramidRegionDefinition`, iOS `MLNTilePyramidOfflineRegion.includesIdeographicGlyphs`), which also requires `MLNIdeographicFontFamilyName` / local CJK rendering so labels never go blank. Re-measure after either change.

**maxzoom note.** The liberty source is the OpenFreeMap planet TileJSON (`https://tiles.openfreemap.org/planet`, `maxzoom: 14`). Zoom 14 is the last zoom with its own tiles; at zoom 15 and above MapLibre overzooms the zoom-14 data, so a z11–14 pack covers every zoom the phone shows inside the bbox, at zoom-14 detail (buildings, footways, addresses as present in OpenMapTiles z14). Outside the bbox the plain background returns (QA T19). The TileJSON's `tiles` path is dated (`…/planet/20260927_080001_pt/{z}/{x}/{y}.pbf` on the measurement day) and rolls weekly; the pack's date is shown on S-12 and "Download again" replaces the region.

**Bundled style snapshot.** `assets/map/style.json` is the liberty style with absolute sprite / glyph / source URLs and `metadata._fetchedAt` / `_source`; the vector source keeps the TileJSON indirection (`url`) rather than the dated `tiles` path, so an online map always reads the current tiles and an offline map without a pack shows the style's own background and the report pins (plan §23.F test wording). Licence as §5: © OpenFreeMap © OpenMapTiles © OpenStreetMap contributors, shown over the map in every state.
