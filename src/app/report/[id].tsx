/**
 * S-08 Report detail (spec R7): the social object of the app. Evidence, the AI read, the vote with its visible
 * threshold, the score with all five terms, the honest status timeline, nearby related orders, share and follow.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';

import { distanceM } from '@/domain/geo';
import { subtypeDef } from '@/domain/taxonomy';
import { RESIDENT_WORDING } from '@/domain/status';
import { daysBetween } from '@/domain/time';
import { VOTE_THRESHOLDS } from '@/domain/votes';
import { t, tn } from '@/i18n';
import { requireSession } from '@/services/auth';
import { useNow, useReport, useReports, useVantage } from '@/store/derived';
import { Screen } from '@/ui/Screen';
import { Button, Callout, Cell, Group, KeyValue, ProgressBar, SectionFooter, SectionHeader } from '@/ui/primitives';
import { ReportRow, StatusTimeline, VoteControl } from '@/ui/report-widgets';
import { ScoreBreakdown } from '@/ui/score-widgets';
import { SeverityBars } from '@/ui/severity-widgets';
import { Icon, categoryIcon } from '@/ui/icons';
import { colors, type } from '@/ui/theme';

export default function ReportDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const report = useReport(id);
  const all = useReports();
  const from = useVantage();
  const now = useNow();
  const [needSignIn, setNeedSignIn] = useState(false);

  if (!report) {
    return (
      <Screen title={t('report.title')} testID="report-detail">
        <Callout icon="info" title="Report not found">This report is not saved on this phone. Connect and refresh to load it.</Callout>
      </Screen>
    );
  }

  const nearby = all.filter((o) => o.id !== report.id && distanceM(o, report) <= 300).slice(0, 3);
  const need = VOTE_THRESHOLDS.supervisorReview;

  async function act(reason: 'vote' | 'follow') {
    const session = await requireSession(reason);
    if (!session) setNeedSignIn(true);
    // M1: queue the mutation.
  }

  return (
    <Screen title={t('report.title')} testID="report-detail">
      <Group>
        <View style={styles.photo}>
          <Icon name={report.photos.length ? 'photo' : categoryIcon(report.category)} size={40} color={colors.ink2} />
          <Text style={[type.footnote, { marginTop: 8, textAlign: 'center' }]}>{report.photos.length ? `${report.photos.length} photo${report.photos.length === 1 ? '' : 's'}` : t('report.photosPending')}</Text>
        </View>
      </Group>
      <Group padded>
        <Text style={[type.footnote, { marginBottom: 2 }]}>{report.id}{report.isDemo ? ` · ${t('common.demo').toLowerCase()}` : ''}</Text>
        <Text style={type.title3} accessibilityRole="header">{report.title}</Text>
        <View style={styles.badges}>
          <SeverityBars band={report.severity} size="sm" />
          <Text style={type.footnote}>{RESIDENT_WORDING[report.status]}</Text>
          {report.stormSensitivity.length ? <Text style={[type.footnote, { color: colors.blue }]}>{t('feed.storm')}</Text> : null}
        </View>
        <Text style={[type.subheadline, { marginTop: 8 }]}>{report.addressText}{report.addressConfidence === 'approx' ? ' (approximate)' : ''}</Text>
        <View style={styles.voteRow}>
          <VoteControl count={report.voteCount} voted={false} onPress={() => void act('vote')} testID="vote" />
          <View style={{ flex: 1 }}>
            <ProgressBar pct={Math.min(100, Math.round((report.voteCount / need) * 100))} color={colors.brand} height={6} />
            <Text style={[type.footnote, { marginTop: 4 }]}>{report.voteCount >= need ? t('vote.thresholdPassed') : t('vote.threshold', { n: report.voteCount, need })}</Text>
          </View>
        </View>
        {needSignIn ? <Callout icon="signIn" tone="tint" title={t('vote.signIn')} style={{ marginTop: 10 }}>{t('me.signedOut')}</Callout> : null}
      </Group>

      <SectionHeader>{t('score.title')}</SectionHeader>
      <Group padded>
        <ScoreBreakdown score={report.score} terms={report.scoreTerms} stormMultiplier={report.stormMultiplier} />
      </Group>
      <Group>
        <Cell icon="question" iconColor={colors.tint} title={t('score.why')} accessory="chevron" onPress={() => router.push({ pathname: '/why/score/[id]', params: { id: report.id } })} last />
      </Group>

      <SectionHeader>What we know</SectionHeader>
      <Group>
        <KeyValue k="Sub-type" v={subtypeDef(report.subtype).label} />
        <KeyValue k="Severity" v={`${t(`severity.${report.severity}` as const)}${report.severityConfirmed ? ' · confirmed' : ` · ${t('common.notConfirmed').toLowerCase()}`}`} />
        <KeyValue k="Open" v={tn(daysBetween(report.createdAt, now), 'feed.daysOpen')} />
        <KeyValue k="Reported by" v={report.reporterDisplay === 'anonymous' ? 'Anonymous' : (report.reporterName ?? 'Resident')} last />
      </Group>

      <SectionHeader>{t('report.timeline')}</SectionHeader>
      <Group padded>
        <StatusTimeline status={report.status} events={report.timeline} />
      </Group>
      <SectionFooter>“Made safe temporarily” is shown separately from the permanent fix: a cone or a wedge stops the clock, it does not close the order.</SectionFooter>

      {nearby.length ? (
        <>
          <SectionHeader>{t('report.nearby')}</SectionHeader>
          <Group>
            {nearby.map((o, i) => <ReportRow key={o.id} report={o} now={now} from={from} onPress={() => router.push({ pathname: '/report/[id]', params: { id: o.id } })} last={i === nearby.length - 1} />)}
          </Group>
        </>
      ) : null}

      <Button title={t('report.share')} icon="share" onPress={() => void Share.share({ message: `${report.title} — ${report.addressText}. Priority score ${Math.round(report.score)}/100. Add your urgency vote in RootCause.` }).catch(() => {})} style={{ marginTop: 8 }} />
      <Button title={t('report.follow')} variant="secondary" icon="bellOutline" onPress={() => void act('follow')} style={{ marginTop: 8 }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  photo: { height: 150, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.fill, paddingHorizontal: 24 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' },
  voteRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
});
