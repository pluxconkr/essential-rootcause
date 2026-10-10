/**
 * "How is this scored?" for the open-hazard index (spec R1 "Risk index always explains its drivers in plain
 * language"; plan §13 every number on screen is explainable). What the index is — the mean priority score of the
 * open reports within the radius of where you are, not a prediction — the three drivers it names, the statuses that
 * count as open, and the published weights behind each score (/why/score/[id] shows one report's arithmetic). Reads
 * the same hazardIndex() the home card renders, so the figures here are the figures there.
 */
import { useRouter } from 'expo-router';

import { DEFAULT_WEIGHTS } from '@/domain/score';
import { t } from '@/i18n';
import { useAppState } from '@/store/appStore';
import { useHazardIndex } from '@/store/derived';
import { Screen, goBackOr } from '@/ui/Screen';
import { Body, Button, Cell, Group, KeyValue, SectionFooter, SectionHeader } from '@/ui/primitives';
import { categoryIcon } from '@/ui/icons';
import { colors } from '@/ui/theme';

/** store/derived.ts useHazardIndex() default — the home card's radius. */
export const HAZARD_INDEX_RADIUS_M = 800;
/** store/derived.ts OPEN — a status that still has work owed (domain/status.ts isOpen). */
const OPEN_STATUSES = ['new', 'triaged', 'assessed', 'mitigated', 'scheduled'] as const;

export default function WhyIndexScreen() {
  const router = useRouter();
  const index = useHazardIndex(HAZARD_INDEX_RADIUS_M);
  const fix = useAppState((s) => s.location);
  const home = useAppState((s) => s.prefs.home);
  const vantage = fix ? t('why.index.fromFix') : home ? t('why.index.fromHome') : t('why.index.fromPilot');
  return (
    <Screen title={t('why.index.title')} largeTitle={t('why.index.title')} fallback="/" testID="why-index">
      <Body style={{ marginBottom: 12 }}>{t('why.index.body')}</Body>
      <SectionHeader>{t('why.index.now')}</SectionHeader>
      <Group>
        <KeyValue k={t('home.index.title')} v={String(index.value)} />
        <KeyValue k={t('why.index.count')} v={String(index.count)} />
        <KeyValue k={t('why.index.radius')} v={`${HAZARD_INDEX_RADIUS_M} m`} />
        <KeyValue k={t('why.index.from')} v={vantage} last />
      </Group>
      <SectionFooter>{t('why.index.formula')}</SectionFooter>

      <SectionHeader>{t('why.index.drivers')}</SectionHeader>
      <Group>
        {index.drivers.length === 0 ? (
          <Cell icon="info" iconColor={colors.ink2} title={t('why.index.noDrivers')} last />
        ) : (
          index.drivers.map((r, i) => <Cell key={r.id} icon={categoryIcon(r.category)} iconColor={colors.ink2} title={r.title} subtitle={`${r.addressText} · ${t('score.title').toLowerCase()} ${Math.round(r.score)}`} value={String(Math.round(r.score))} accessory="chevron" onPress={() => router.push({ pathname: '/why/score/[id]', params: { id: r.id } })} last={i === index.drivers.length - 1} testID={`why-driver-${r.id}`} />)
        )}
      </Group>
      <SectionFooter>{t('why.index.driversHint')}</SectionFooter>

      <SectionHeader>{t('why.index.open')}</SectionHeader>
      <Group>
        {OPEN_STATUSES.map((s, i) => (
          <KeyValue key={s} k={t(`status.${s}` as const)} v={t('why.index.counted')} last={i === OPEN_STATUSES.length - 1} />
        ))}
      </Group>
      <SectionFooter>{t('why.index.openHint')}</SectionFooter>

      <SectionHeader>{t('why.index.weights')}</SectionHeader>
      <Group>
        <KeyValue k={t('score.severity')} v={DEFAULT_WEIGHTS.severity.toFixed(2)} />
        <KeyValue k={t('score.exposure')} v={DEFAULT_WEIGHTS.exposure.toFixed(2)} />
        <KeyValue k={t('score.community')} v={DEFAULT_WEIGHTS.community.toFixed(2)} />
        <KeyValue k={t('score.liability')} v={DEFAULT_WEIGHTS.liability.toFixed(2)} />
        <KeyValue k={t('score.decay')} v={DEFAULT_WEIGHTS.decay.toFixed(2)} last />
      </Group>
      <SectionFooter>{t('why.index.weightsHint')}</SectionFooter>
      <Button title={t('common.back')} variant="secondary" onPress={() => goBackOr(router, '/')} />
    </Screen>
  );
}
