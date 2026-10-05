/**
 * Pure helpers for the intake flow S-04…S-07 (spec 4.1; plan §9.1): the queue position S-07 shows, computed from
 * the reports saved on this phone because the server does not return one yet, and the list of known places a
 * resident confirms a library photo's location against (plan §9.1 S-04 "library photos require confirming the
 * location"; M1 does this without a map). Pure module: no React Native or Expo imports.
 */
import { distanceM, type LatLng } from './geo';
import type { LocationFix, Prefs, PublicReport } from './types';

/** Below this confidence S-05 says "unclear" and prefills nothing. */
export const PROPOSAL_FLOOR = 0.7; // spec: plan §3.6 confidence floor 0.70

const OPEN = new Set(['new', 'triaged', 'assessed', 'mitigated', 'scheduled']);

/** 1-based position of `report` among the open reports of its category by score (a tie goes to the older report) and the size of that queue. */
export function rankInCategory(reports: PublicReport[], report: PublicReport): { rank: number; total: number } {
  const others = reports.filter((r) => r.id !== report.id && r.category === report.category && OPEN.has(r.status));
  const ahead = others.filter((r) => r.score > report.score || (r.score === report.score && r.createdAt < report.createdAt)).length;
  return { rank: ahead + 1, total: others.length + 1 };
}

export interface PlaceCandidate {
  id: string;
  label: string;
  detail: string;
  lat: number;
  lng: number;
  /** Known only for the GPS fix; null means "approximate" and the report says so. */
  accuracyM: number | null;
  addressText: string | null;
}

/** Known addresses are offered from reports within walking distance of where the resident is (or lives). */
export const PLACE_SEARCH_M = 1500;
export const PLACE_MAX = 5;

function formatM(m: number): string {
  return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

/** The GPS fix first, then the nearest distinct addresses of saved reports, the home area, and the pilot centre as the last resort. */
export function placeCandidates(input: { fix: LocationFix | null; home: Prefs['home']; reports: PublicReport[]; center: LatLng; centerName: string }): PlaceCandidate[] {
  const out: PlaceCandidate[] = [];
  const vantage: LatLng = input.fix ?? input.home ?? input.center;
  if (input.fix) out.push({ id: 'gps', label: 'Where you are now', detail: input.fix.accuracyM != null ? `GPS fix · ±${Math.round(input.fix.accuracyM)} m` : 'GPS fix', lat: input.fix.lat, lng: input.fix.lng, accuracyM: input.fix.accuracyM, addressText: null });
  const seen = new Set<string>();
  const nearby = input.reports
    .map((r) => ({ r, d: distanceM(vantage, r) }))
    .filter(({ r, d }) => d <= PLACE_SEARCH_M && r.addressText.trim().length > 0)
    .sort((a, b) => a.d - b.d);
  for (const { r, d } of nearby) {
    const address = r.addressText.trim();
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `report:${r.id}`, label: address, detail: `${formatM(d)} away · ${r.title}${r.isDemo ? ' · demo' : ''}`, lat: r.lat, lng: r.lng, accuracyM: null, addressText: address });
    if (seen.size >= PLACE_MAX) break;
  }
  if (input.home) out.push({ id: 'home', label: 'Your home area', detail: `Centre of the ${input.home.radiusM} m area you chose`, lat: input.home.lat, lng: input.home.lng, accuracyM: null, addressText: null });
  out.push({ id: 'pilot', label: `${input.centerName} centre`, detail: 'Approximate — the crew will rely on your photo and note', lat: input.center.lat, lng: input.center.lng, accuracyM: null, addressText: null });
  return out;
}
