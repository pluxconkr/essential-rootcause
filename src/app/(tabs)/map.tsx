/**
 * S-02 Map (spec R2). M0: the list form of the map — nearest reports with distances, filterable, from local data.
 * M1 adds the MapLibre view (owner decision D2) above this list; the list stays as the screen-reader mirror of the pins.
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';

import { CATEGORIES, CATEGORY_LABEL } from '@/domain/taxonomy';
import type { Category } from '@/domain/types';
import { t } from '@/i18n';
import { demoNote } from '@/services/demo';
import { useFeed, useNow, useVantage } from '@/store/derived';
import { Screen } from '@/ui/Screen';
import { Button, Cell, Group, SectionFooter, SectionHeader, Segmented } from '@/ui/primitives';
import { ReportRow } from '@/ui/report-widgets';
import { colors } from '@/ui/theme';

export default function MapScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<Category | 'all'>('all');
  const nearest = useFeed('distance', filter);
  const from = useVantage();
  const now = useNow();
  return (
    <Screen largeTitle={t('map.title')} subtitle={t('map.subtitle')} note={demoNote()} testID="map">
      <Segmented options={[{ value: 'all', label: t('feed.filter.all') }, ...CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))]} value={filter} onChange={setFilter} />
      <SectionHeader>Nearest to you</SectionHeader>
      <Group>
        {nearest.length === 0 ? <Cell icon="pin" iconColor={colors.ink2} title={t('home.empty.title')} subtitle={t('home.empty.body')} last /> : nearest.slice(0, 20).map((r, i) => <ReportRow key={r.id} report={r} now={now} from={from} onPress={() => router.push({ pathname: '/report/[id]', params: { id: r.id } })} last={i === Math.min(nearest.length, 20) - 1} />)}
      </Group>
      <SectionFooter>{t('map.attribution')}</SectionFooter>
      <Button title={t('map.reportHere')} icon="camera" onPress={() => router.push('/new')} style={{ marginTop: 8 }} />
    </Screen>
  );
}
