/**
 * S-02 Map (spec R2; plan §3.3, §9.1, §9.6, §13; owner decision D2). The MapLibre HazardMap on top — pins coloured
 * by severity band and sized by votes, clustered — fed by the same reports as the list below it (nearest first), a
 * category filter that narrows both, a peek card for the selected pin, and "Report what I see here". Pins render
 * from local data with or without tiles; offline the map says so. The list is the screen-reader mirror of the pins.
 */
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CATEGORIES, CATEGORY_LABEL } from '@/domain/taxonomy';
import type { Category } from '@/domain/types';
import { t } from '@/i18n';
import { demoNote } from '@/services/demo';
import { isOfflineNow, useAppState } from '@/store/appStore';
import { useFeed, useNow, useVantage } from '@/store/derived';
import { HazardMap } from '@/ui/HazardMap';
import { toPins } from '@/ui/HazardMap.shared';
import { MapPeek } from '@/ui/MapPeek';
import { Screen } from '@/ui/Screen';
import { Button, Cell, Group, SectionFooter, SectionHeader, Segmented } from '@/ui/primitives';
import { ReportRow } from '@/ui/report-widgets';
import { GUTTER, colors, radius } from '@/ui/theme';

/** The map takes about 55 % of the screen; the list mirror continues below the fold (plan: S-02 layout). */
export const MAP_HEIGHT_FRACTION = 0.55;

export default function MapScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [filter, setFilter] = useState<Category | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scrollEnabled, setScrollEnabled] = useState(true);
  const reports = useFeed('distance', filter);
  const from = useVantage();
  const now = useNow();
  const offline = useAppState((s) => isOfflineNow(s));
  const pins = useMemo(() => toPins(reports), [reports]);
  const selected = selectedId ? (reports.find((r) => r.id === selectedId) ?? null) : null;
  const mapHeight = Math.round(windowHeight * MAP_HEIGHT_FRACTION);

  const open = (id: string) => router.push({ pathname: '/report/[id]', params: { id } });

  return (
    <Screen largeTitle={t('map.title')} subtitle={t('map.subtitle')} note={demoNote()} status scroll={false} padded={false} contentStyle={{ flex: 1 }} testID="map">
      <View style={styles.filter}>
        <Segmented options={[{ value: 'all', label: t('feed.filter.all') }, ...CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))]} value={filter} onChange={setFilter} label="Category" />
      </View>
      <ScrollView style={{ flex: 1 }} scrollEnabled={scrollEnabled} contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: insets.bottom + 32 }} keyboardShouldPersistTaps="handled">
        {/* While a finger is on the map the page does not scroll, so panning the map pans the map. */}
        <View style={styles.mapWrap} onTouchStart={() => setScrollEnabled(false)} onTouchEnd={() => setScrollEnabled(true)} onTouchCancel={() => setScrollEnabled(true)}>
          <HazardMap pins={pins} center={from} selectedId={selectedId} onSelect={setSelectedId} offline={offline} height={mapHeight} />
          {selected ? (
            <View style={styles.peek}>
              <MapPeek report={selected} now={now} from={from} onOpen={() => open(selected.id)} onClose={() => setSelectedId(null)} />
            </View>
          ) : null}
        </View>
        <SectionHeader right={reports.length ? `${reports.length} on the map` : undefined}>Nearest to you</SectionHeader>
        <Group>
          {reports.length === 0 ? (
            <Cell icon="pin" iconColor={colors.ink2} title={t('home.empty.title')} subtitle={t('home.empty.body')} last />
          ) : (
            reports.map((r, i) => <ReportRow key={r.id} report={r} now={now} from={from} onPress={() => open(r.id)} last={i === reports.length - 1} testID={`map-row-${r.id}`} />)
          )}
        </Group>
        <SectionFooter>Every pin on the map is in this list, nearest first. {t('map.attribution')}</SectionFooter>
        <Button title={t('map.reportHere')} icon="camera" onPress={() => router.push('/new')} style={{ marginTop: 8 }} testID="map-report-here" />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  filter: { paddingHorizontal: GUTTER, paddingBottom: 10 },
  mapWrap: { borderRadius: radius.group, overflow: 'hidden', backgroundColor: colors.fill },
  peek: { position: 'absolute', left: 8, right: 8, bottom: 8 },
});
