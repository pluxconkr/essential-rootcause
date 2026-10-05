/**
 * Network state → store. Offline is a state, not an error.
 */
import * as Network from 'expo-network';
import { Platform } from 'react-native';

import { actions, type NetworkInfo } from '@/store/appStore';

export function toNetworkInfo(s: Network.NetworkState): NetworkInfo {
  if (Platform.OS === 'web') {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    return { online: nav ? nav.onLine : true, type: s.type ?? null };
  }
  if (s.isConnected === undefined && s.isInternetReachable === undefined) return { online: null, type: s.type ?? null };
  const offline = s.isConnected === false || s.isInternetReachable === false;
  return { online: !offline, type: s.type ?? null };
}

let subscription: { remove: () => void } | null = null;

/** Start watching connectivity. Idempotent. Returns a stop function. */
export function startNetworkWatch(onChange?: (info: NetworkInfo) => void): () => void {
  Network.getNetworkStateAsync()
    .then((s) => {
      const info = toNetworkInfo(s);
      actions.setNetwork(info);
      onChange?.(info);
    })
    .catch(() => actions.setNetwork({ online: null, type: null }));
  if (!subscription) {
    subscription = Network.addNetworkStateListener((s) => {
      const info = toNetworkInfo(s);
      actions.setNetwork(info);
      onChange?.(info);
    });
  }
  return () => {
    subscription?.remove();
    subscription = null;
  };
}
