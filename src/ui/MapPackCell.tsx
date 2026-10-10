/**
 * Offline map section for S-12 Offline data (plan §9.1 S-12, §9.6, §23.F): the pack's state, its size (the measured
 * estimate before download, the real bytes after), the date it was downloaded, and the download / download-again /
 * remove actions. Downloads only over Wi-Fi. Progress lives in the button title and a ProgressBar — no spinners.
 */
import { useEffect } from 'react';
import { View } from 'react-native';

import { formatDate, relativeAgo } from '@/domain/time';
import { MAP_PACK, MAP_PACK_SUPPORTED, downloadMapPack, isWifi, refreshMapPackStatus, removeMapPack, useMapPack, type MapPackError } from '@/services/mapOffline';
import { isOfflineNow, useAppState } from '@/store/appStore';
import { useRealNow } from '@/store/derived';

import { Button, Callout, Cell, Group, KeyValue, ProgressBar, SectionFooter, SectionHeader } from './primitives';
import { colors } from './theme';

const ESTIMATE = `about ${MAP_PACK.estimateMB} MB`;
const ESTIMATE_SENTENCE = `About ${MAP_PACK.estimateMB} MB`;

const ERROR_COPY: Record<MapPackError, { title: string; body: string }> = {
  offline: { title: 'No connection', body: `Connect to Wi-Fi to download the map tiles (${ESTIMATE}).` },
  wifi: { title: 'Wi-Fi needed', body: `The map pack is ${ESTIMATE}, so it downloads over Wi-Fi only.` },
  unsupported: { title: 'Not available here', body: 'Offline map packs are available in the iOS and Android development builds of the app.' },
  interrupted: { title: 'Download interrupted', body: 'The last download did not finish. Download again over Wi-Fi; what was saved is reused.' },
  native: { title: 'Download failed', body: 'The map provider did not answer. Try again later; the live map and the saved reports still work.' },
};

export function formatMB(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

export function MapPackCell() {
  const pack = useMapPack();
  const networkType = useAppState((s) => s.network.type);
  const offline = useAppState((s) => isOfflineNow(s));
  const realNow = useRealNow();

  useEffect(() => {
    void refreshMapPackStatus();
  }, []);

  if (!MAP_PACK_SUPPORTED) {
    return (
      <>
        <SectionHeader>Offline map</SectionHeader>
        <Group>
          <Cell icon="map" iconColor={colors.ink2} title={ERROR_COPY.unsupported.body} last />
        </Group>
      </>
    );
  }

  const wifi = isWifi(networkType);
  const downloading = pack.status === 'downloading';
  const ready = pack.status === 'ready';
  const statusText = downloading ? `Downloading · ${pack.percentage}%` : ready ? 'Saved on this phone' : pack.status === 'failed' ? 'Not saved' : 'Not downloaded';
  const sizeText = pack.bytes > 0 ? `${formatMB(pack.bytes)}${ready ? '' : ' so far'}` : ESTIMATE;
  const dateText = pack.completedAt ? `${formatDate(pack.completedAt, { month: 'short', day: 'numeric', year: 'numeric' })} · ${relativeAgo(pack.completedAt, realNow)}` : '—';
  const problem = pack.error ? ERROR_COPY[pack.error] : null;
  const buttonTitle = downloading ? `Downloading… ${pack.percentage}%` : ready ? `Download again (${ESTIMATE})` : `Download map tiles (${ESTIMATE})`;

  return (
    <>
      <SectionHeader>Offline map</SectionHeader>
      <Group>
        <KeyValue k="Map tiles" v={statusText} />
        <KeyValue k="Size" v={sizeText} />
        <KeyValue k="Downloaded" v={dateText} />
        <KeyValue k="Area" v={MAP_PACK.areaLabel} last />
      </Group>
      {downloading ? (
        <View style={{ marginBottom: 10 }}>
          <ProgressBar pct={pack.percentage} color={colors.brand} height={6} label={`${pack.percentage}% downloaded`} />
        </View>
      ) : null}
      {problem ? (
        <Callout icon="info" tone="amber" title={problem.title}>
          {pack.error === 'native' && pack.errorDetail ? `${problem.body} (${pack.errorDetail})` : problem.body}
        </Callout>
      ) : null}
      <Button title={buttonTitle} variant="tonal" icon="download" disabled={downloading || offline || !wifi} onPress={() => void downloadMapPack()} testID="map-pack-download" />
      {ready || pack.status === 'failed' ? <Button title="Remove map tiles" variant="secondary" icon="trash" onPress={() => void removeMapPack()} style={{ marginTop: 8 }} testID="map-pack-remove" /> : null}
      <SectionFooter>
        {wifi ? '' : 'Connect to Wi-Fi to download. '}
        Streets of {MAP_PACK.areaLabel.split(' · ')[0]} at zoom 11–14, the same OpenFreeMap tiles as the live map; closer zooms are drawn from the zoom-14 data. {ESTIMATE_SENTENCE}: the streets are 2 MB, the rest is map fonts, which MapLibre downloads in full. OpenFreeMap refreshes its tiles weekly — download again for the newest streets.
      </SectionFooter>
    </>
  );
}
