/**
 * "Why this score?" (spec §7). Renders the real constants — weights, severity bands, the community cap — next to
 * this report's five terms, so the arithmetic residents and staff see is the one the server ran.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';

import { COMMUNITY_K, DEFAULT_WEIGHTS, SEVERITY_BAND } from '@/domain/score';
import { t } from '@/i18n';
import { useReport } from '@/store/derived';
import { Screen, goBackOr } from '@/ui/Screen';
import { Body, Button, Group, KeyValue, SectionFooter, SectionHeader } from '@/ui/primitives';
import { ScoreBreakdown } from '@/ui/score-widgets';

export default function WhyScoreScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const report = useReport(id);
  return (
    <Screen title={t('score.why')} largeTitle={t('score.why')} testID="why-score">
      <Body style={{ marginBottom: 12 }}>{t('score.whyBody')}</Body>
      {report ? (
        <>
          <SectionHeader>This report</SectionHeader>
          <Group padded>
            <ScoreBreakdown score={report.score} terms={report.scoreTerms} stormMultiplier={report.stormMultiplier} />
          </Group>
        </>
      ) : null}
      <SectionHeader>Weights (city-set, published)</SectionHeader>
      <Group>
        <KeyValue k={t('score.severity')} v={DEFAULT_WEIGHTS.severity.toFixed(2)} />
        <KeyValue k={t('score.exposure')} v={DEFAULT_WEIGHTS.exposure.toFixed(2)} />
        <KeyValue k={t('score.community')} v={DEFAULT_WEIGHTS.community.toFixed(2)} />
        <KeyValue k={t('score.liability')} v={DEFAULT_WEIGHTS.liability.toFixed(2)} />
        <KeyValue k={t('score.decay')} v={DEFAULT_WEIGHTS.decay.toFixed(2)} last />
      </Group>
      <SectionFooter>score = 100 × Σ(weight × term) × storm multiplier (1.0 unless a weather scenario is active). Community is capped at {Math.round(DEFAULT_WEIGHTS.community * 100)}% so an organised block cannot dominate the queue.</SectionFooter>
      <SectionHeader>Severity bands</SectionHeader>
      <Group>
        <KeyValue k={t('severity.1')} v={SEVERITY_BAND[1].toFixed(2)} />
        <KeyValue k={t('severity.2')} v={SEVERITY_BAND[2].toFixed(2)} />
        <KeyValue k={t('severity.3')} v={SEVERITY_BAND[3].toFixed(2)} />
        <KeyValue k={t('severity.4')} v={SEVERITY_BAND[4].toFixed(2)} last />
      </Group>
      <SectionFooter>“Critical” is only set by a person. Your “Emergency” answer pages the on-call supervisor and pins the report to the top of the queue, but the score uses “High” until someone confirms.</SectionFooter>
      <SectionHeader>Community term</SectionHeader>
      <Group>
        <KeyValue k="Saturation constant k" v={COMMUNITY_K.toFixed(2)} />
        <KeyValue k="Normalised by" v="active users in your block group" last />
      </Group>
      <SectionFooter>Votes are scaled per capita and saturate, so the same number of votes counts for more in a block that rarely reports.</SectionFooter>
      <Button title={t('common.back')} variant="secondary" onPress={() => goBackOr(router, '/')} />
    </Screen>
  );
}
