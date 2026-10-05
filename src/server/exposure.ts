/**
 * Exposure proxy and approximate addresses for the API (plan §4 flow 2 "server snaps GPS to nearest address
 * point/road from bundled data (labelled approximate), computes exposure proxy"; §8 "Exposure data"): loads the
 * bundled OSM extract once per module, validates its shape, and answers lookupExposure(lat, lng) and
 * reverseGeocode(lat, lng) for the reports create path (src/server/repos/derive.ts). Never throws: a missing or
 * malformed extract is logged once and every lookup degrades to the off-network defaults (path-level pedestrians, no
 * flags, coordinates as the address), so a bad data build weakens the exposure term rather than report filing.
 * The file is named after the pilot slug (scripts/build-osm.ts); a new pilot area changes this import. Server-only module.
 */
import { EMPTY_OSM_DATA, OsmDataSchema, approximateAddress, exposureInputs, type ApproximateAddress, type ExposureInputs, type OsmData } from '@/domain/exposure';

import { logEvent } from './log';

import raw from '../../assets/data/osm/new-brunswick-nj.json';

function load(): OsmData {
  const parsed = OsmDataSchema.safeParse(raw);
  if (!parsed.success) {
    logEvent('error', 'exposure.data_invalid', { issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.map(String).join('.')}: ${i.message}`) });
    return EMPTY_OSM_DATA;
  }
  if (parsed.data.sample) logEvent('warn', 'exposure.sample_data', { note: parsed.data.note ?? 'hand-made sample extract' });
  return parsed.data;
}

const DATA: OsmData = load();

/** The loaded extract (tests and /api/health may report its counts and date). */
export function osmData(): OsmData {
  return DATA;
}

/** Pedestrians/day proxy and vulnerable-population flags for a point; stored on report.exposure_terms at intake. */
export function lookupExposure(lat: number, lng: number): ExposureInputs {
  return exposureInputs({ lat, lng }, DATA);
}

/** "<number> <street>", "<road> near <cross street>" or rounded coordinates — always address_confidence 'approx'. */
export function reverseGeocode(lat: number, lng: number): ApproximateAddress {
  return approximateAddress({ lat, lng }, DATA);
}
