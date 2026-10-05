/**
 * Pilot area (owner decision D1): New Brunswick, NJ. The map extent, demo data and the default feed bbox are
 * anchored here. Replace the centre and radius when the city changes; nothing else hard-codes a place.
 */
import { bboxAround, type BBox, type LatLng } from './geo';

export const PILOT = {
  slug: process.env.EXPO_PUBLIC_PILOT ?? 'new-brunswick-nj',
  name: 'New Brunswick, NJ',
  center: { lat: 40.4862, lng: -74.4518 } as LatLng,
  /** Radius that covers the city for the default feed and the offline map pack. */
  radiusM: 4000,
  /** Default watch-area radius for a home area (spec R14: "Home · 400m"). */
  homeRadiusM: 400,
} as const;

export const PILOT_BBOX: BBox = bboxAround(PILOT.center, PILOT.radiusM);
