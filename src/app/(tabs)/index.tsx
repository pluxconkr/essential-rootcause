/**
 * S-01 Home / feed (spec R1). The open-hazard index that names its own drivers, then the ranked local queue
 * with the urgency vote inline, then the barometer. Everything renders from local data; refresh is cache-first.
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { CATEGORIES, CATEGORY_LABEL } from '@/domain/taxonomy';
import { DEFAULT_WEIGHTS } from '@/domain/score';
import type { Category } from '@/domain/types';
import { t } from '@/i18n';
import { requireSession } from '@/services/auth';
import { demoNote } from '@/services/demo';
import { refreshAll } from '@/services/refresh';
import { useAppState } from '@/store/appStore';
import { useFeed, useHazardIndex, useNow, useVantage, type FeedSort } from '@/store/derived';
import { Screen } from '@/ui/Screen';
import { Callout, Cell, Group, ProgressRing, SectionFooter, SectionHeader, Segmented } from '@/ui/primitives';
import { ReportRow } from '@/ui/report-widgets';
import { colors, scoreTone, toneColor, type } from '@/ui/theme';

export default function HomeScreen() {
  const router = useRouter();
  const [sort, setSort] = useState<FeedSort>('urgency');
  const [filter, setFilter] = useState<Category | 'all'>('all');
  const [needSignIn, setNeedSignIn] = useState(false);
  const refreshing = useAppState((s) => s.refreshing);
  const scenario = useAppState((s) => s.settings.demoScenario);
  const feed = useFeed(sort, filter);
  const index = useHazardIndex();
  const from = useVantage();
  const now = useNow();

  async function vote(reportId: string) {
    const session = await requireSession('vote');
    if (!session) {
      setNeedSignIn(true);
      return;
    }
    // M1: queue the vote mutation; until then the control is a visible promise, not a silent no-op.
    void reportId;
  }

  return (
    <Screen largeTitle={t('home.title')} status note={demoNote()} onRefresh={() => void refreshAll()} refreshing={refreshing} testID="home">
      <SectionHeader>{t('home.index.title')}</SectionHeader>
      <Group padded>
        <View style={styles.indexRow}>
          <ProgressRing pct={index.value} size={64} stroke={7} color={toneColor[scoreTone(index.value)]}>
            <Text maxFontSizeMultiplier={1.3} style={[type.headline, { color: colors.ink }]}>
              {index.value}
            </Text>
          </ProgressRing>
          <View style={{ flex: 1 }}>
            <Text style={type.subheadline}>{t('home.index.body')}</Text>
            {index.drivers.length ? (
              <Text style={[type.footnote, { marginTop: 4 }]} numberOfLines={3}>
                {index.drivers.map((d) => d.title).join(' · ')}
              </Text>
            ) : null}
          </View>
        </View>
      </Group>

      <SectionHeader right={<Segmented options={[{ value: 'urgency', label: 'Urgency' }, { value: 'distance', label: 'Distance' }, { value: 'newest', label: 'Newest' }]} value={sort} onChange={setSort} />}>{t('home.feed')}</SectionHeader>
      <View style={{ marginBottom: 10 }}>
        <Segmented options={[{ value: 'all', label: t('feed.filter.all') }, ...CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))]} value={filter} onChange={setFilter} />
      </View>
      {needSignIn ? (
        <Callout icon="signIn" tone="tint" title={t('vote.signIn')}>
          {t('me.signedOut')}
        </Callout>
      ) : null}
      <Group>
        {feed.length === 0 ? (
          <Cell icon="info" iconColor={colors.ink2} title={t('home.empty.title')} subtitle={t('home.empty.body')} last />
        ) : (
          feed.map((r, i) => <ReportRow key={r.id} report={r} now={now} from={from} onPress={() => router.push({ pathname: '/report/[id]', params: { id: r.id } })} onVote={() => void vote(r.id)} last={i === feed.length - 1} testID={`report-${r.id}`} />)
        )}
      </Group>
      {scenario ? <SectionFooter>{t('home.index.body')}</SectionFooter> : null}

      <SectionHeader>{t('home.barometer.title')}</SectionHeader>
      <Group padded>
        <Text style={type.subheadline}>{t('home.barometer.body', { pct: Math.round(DEFAULT_WEIGHTS.community * 100) })}</Text>
      </Group>
    </Screen>
  );
}

const styles = StyleSheet.create({
  indexRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
});
