/**
 * S-01 Home / feed (spec R1). The open-hazard index that names its own drivers, then the ranked local queue
 * with the urgency vote inline, then the barometer. Everything renders from local data; refresh is cache-first.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { demoStormAlertItem } from '@/domain/alerts';
import { CATEGORIES, CATEGORY_SHORT } from '@/domain/taxonomy';
import { DEFAULT_WEIGHTS } from '@/domain/score';
import type { Category } from '@/domain/types';
import { t } from '@/i18n';
import { applyDemoScenario, demoNote, isDemoScenario } from '@/services/demo';
import * as engagement from '@/services/engagement';
import { refreshAll } from '@/services/refresh';
import { useAppState } from '@/store/appStore';
import { useFeed, useHazardIndex, useNow, useReports, useVantage, type FeedSort } from '@/store/derived';
import { Screen } from '@/ui/Screen';
import { Button, Callout, Cell, Group, ProgressRing, SectionFooter, SectionHeader, Segmented } from '@/ui/primitives';
import { ReportRow } from '@/ui/report-widgets';
import { colors, scoreTone, toneColor, type } from '@/ui/theme';

export default function HomeScreen() {
  const router = useRouter();
  const { demo } = useLocalSearchParams<{ demo?: string }>();
  // Deep link `rootcause://?demo=storm` (also calm, verify; docs/QA.md): the judging video and the simulator loop use it.
  useEffect(() => {
    if (demo === 'off') applyDemoScenario(null);
    else if (isDemoScenario(demo)) applyDemoScenario(demo);
  }, [demo]);
  const [sort, setSort] = useState<FeedSort>('urgency');
  const [filter, setFilter] = useState<Category | 'all'>('all');
  const [needSignIn, setNeedSignIn] = useState(false);
  const refreshing = useAppState((s) => s.refreshing);
  const votedIds = useAppState((s) => s.votedIds);
  const scenario = useAppState((s) => s.settings.demoScenario);
  const feed = useFeed(sort, filter);
  const allReports = useReports();
  // Reports you backed that the city has since scheduled, fixed or closed (spec R1 barometer "now scheduled").
  const movedByVotes = useMemo(() => allReports.filter((r) => votedIds.includes(r.id) && (r.status === 'scheduled' || r.status === 'completed' || r.status === 'verified')).length, [allReports, votedIds]);
  const index = useHazardIndex();
  const from = useVantage();
  const now = useNow();
  const alerts = useAppState((s) => s.alerts);
  const reports = useReports();
  // R1 hero: the active predictive alert — the storm demo's labelled advisory, else the newest unread weather alert with a briefing.
  const hero = useMemo(() => (scenario === 'storm' ? demoStormAlertItem(reports, now) : (alerts.find((a) => a.kind !== 'status' && !a.read && a.briefing) ?? null)), [scenario, reports, now, alerts]);

  async function vote(reportId: string) {
    const res = await engagement.vote(reportId, !votedIds.includes(reportId));
    if (!res.ok && res.reason === 'sign_in') setNeedSignIn(true);
  }

  return (
    <Screen largeTitle={t('home.title')} status note={demoNote()} onRefresh={() => void refreshAll()} refreshing={refreshing} testID="home">
      {hero ? (
        <View testID="home-hero">
          <Group padded style={styles.hero}>
            <Text style={[type.footnote, { color: colors.amber, fontWeight: type.headline.fontWeight }]}>{t('home.hero.title')}</Text>
            <Text style={[type.title3, { marginTop: 4 }]} accessibilityRole="header">
              {hero.title}
              {hero.isDemo ? ` · ${t('common.demo').toLowerCase()}` : ''}
            </Text>
            <Text style={[type.subheadline, { marginTop: 4 }]}>{hero.body}</Text>
            <View style={styles.heroButtons}>
              <Button title={t('home.hero.spots')} icon="pin" size="sm" onPress={() => router.push({ pathname: '/alert/[id]', params: { id: hero.id } })} testID="home-hero-spots" />
              <Button title={t('home.hero.open')} variant="secondary" size="sm" onPress={() => router.push('/alerts')} testID="home-hero-open" />
            </View>
          </Group>
        </View>
      ) : null}
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
      <Group style={{ marginTop: 10 }}>
        <Cell icon="map" iconColor={colors.tint} title={t('home.mapView')} accessory="chevron" onPress={() => router.push('/map')} testID="home-map-link" />
        <Cell icon="question" iconColor={colors.tint} title={t('home.howScored')} accessory="chevron" onPress={() => router.push('/why')} last testID="home-why-link" />
      </Group>

      <SectionHeader>{t('home.feed')}</SectionHeader>
      <View style={{ marginBottom: 8 }}>
        <Segmented options={[{ value: 'urgency', label: 'Urgency' }, { value: 'distance', label: 'Distance' }, { value: 'newest', label: 'Newest' }]} value={sort} onChange={setSort} label="Sort" />
      </View>
      <View style={{ marginBottom: 10 }}>
        <Segmented options={[{ value: 'all', label: t('feed.filter.all') }, ...CATEGORIES.map((c) => ({ value: c, label: CATEGORY_SHORT[c] }))]} value={filter} onChange={setFilter} label="Category" />
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
          feed.map((r, i) => <ReportRow key={r.id} report={r} now={now} from={from} voted={votedIds.includes(r.id)} onPress={() => router.push({ pathname: '/report/[id]', params: { id: r.id } })} onVote={() => void vote(r.id)} last={i === feed.length - 1} testID={`report-${r.id}`} />)
        )}
      </Group>
      {scenario ? <SectionFooter>{t('home.index.body')}</SectionFooter> : null}

      <SectionHeader>{t('home.barometer.title')}</SectionHeader>
      <Group padded>
        <Text style={type.subheadline}>{t('home.barometer.body', { pct: Math.round(DEFAULT_WEIGHTS.community * 100) })}</Text>
        <View style={styles.barometerRow}>
          <View style={styles.barometerStat}>
            <Text style={[type.title1, { color: colors.ink }]} testID="home-votes-cast">
              {votedIds.length}
            </Text>
            <Text style={type.footnote}>{votedIds.length === 1 ? t('home.barometer.castOne') : t('home.barometer.cast')}</Text>
          </View>
          <View style={styles.barometerStat}>
            <Text style={[type.title1, { color: colors.ink }]} testID="home-votes-moved">
              {movedByVotes}
            </Text>
            <Text style={type.footnote}>{t('home.barometer.moved')}</Text>
          </View>
        </View>
      </Group>
    </Screen>
  );
}

const styles = StyleSheet.create({
  indexRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  barometerRow: { flexDirection: 'row', gap: 24, marginTop: 12 },
  barometerStat: { flex: 1 },
  hero: { marginTop: 10, backgroundColor: colors.amberSoft },
  heroButtons: { flexDirection: 'row', gap: 8, marginTop: 12 },
});
