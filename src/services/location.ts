/**
 * GPS works without a signal (satellites, not cell towers). We ask once, use the last
 * known fix instantly, then refine. The feed never waits on this.
 */
import * as Location from 'expo-location';
import { Platform } from 'react-native';

import type { LocationFix } from '@/domain/types';
import { actions } from '@/store/appStore';

function toFix(l: Location.LocationObject): LocationFix {
  return { lat: l.coords.latitude, lng: l.coords.longitude, accuracyM: l.coords.accuracy ?? null, at: l.timestamp };
}

export async function acquireLocation(): Promise<LocationFix | null> {
  actions.setLocation(null, 'requesting');
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) {
      actions.setLocation(null, 'denied');
      return null;
    }
    if (Platform.OS !== 'web') {
      const last = await Location.getLastKnownPositionAsync({ maxAge: 15 * 60_000 });
      if (last) actions.setLocation(toFix(last), 'granted');
    }
    const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    const fix = toFix(cur);
    actions.setLocation(fix, 'granted');
    return fix;
  } catch {
    actions.setLocation(null, 'unavailable');
    return null;
  }
}
