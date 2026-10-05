/**
 * /r/[id] — the public web share page for one report (plan §23.J "the /r/[id] public report page (share-link
 * target)"; §12: every non-staff view goes through the server's toPublicReport()). Read-only: the report is fetched
 * from GET /api/v1/reports/:id in an effect (no local cache on the web), then rendered as the phone would — title,
 * address, severity bars, the score with its five terms, the status timeline — with "Open in RootCause"
 * (rootcause://report/<id>) for people who have the app. Also renders natively and in jest, so a deep link that lands
 * here still shows the report.
 */
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { RESIDENT_WORDING } from '@/domain/status';
import { subtypeDef } from '@/domain/taxonomy';
import { daysBetween } from '@/domain/time';
import type { PublicReport } from '@/domain/types';
import { t, tn } from '@/i18n';
import { fetchReport } from '@/services/engagement';
import { useRealNow } from '@/store/derived';
import { Screen } from '@/ui/Screen';
import { Button, Callout, Group, KeyValue, SectionFooter, SectionHeader } from '@/ui/primitives';
import { StatusTimeline } from '@/ui/report-widgets';
import { ScoreBreakdown } from '@/ui/score-widgets';
import { SeverityBars } from '@/ui/severity-widgets';
import { colors, type } from '@/ui/theme';

/** The app's deep link for a report (plan §9.5 `rootcause://report/<id>`). */
export const appLink = (id: string) => `rootcause://report/${encodeURIComponent(id)}`;

type PageState = { kind: 'loading' } | { kind: 'ok'; report: PublicReport } | { kind: 'missing' } | { kind: 'failed' };

export default function PublicReportPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const now = useRealNow();
  // The answer is remembered with the id it was fetched for, so a new id reads as "loading" without a reset.
  const [fetched, setFetched] = useState<{ forId: string; result: PageState } | null>(null);
  const state: PageState = !id ? { kind: 'missing' } : fetched?.forId === id ? fetched.result : { kind: 'loading' };

  useEffect(() => {
    if (!id) return;
    let alive = true;
    void fetchReport(id).then((res) => {
      if (!alive) return;
      setFetched({ forId: id, result: res.report ? { kind: 'ok', report: res.report } : { kind: res.status === 404 ? 'missing' : 'failed' } });
    });
    return () => {
      alive = false;
    };
  }, [id]);

  const report = state.kind === 'ok' ? state.report : null;
  return (
    <Screen largeTitle={report ? report.title : 'RootCause report'} subtitle={report ? report.addressText : undefined} testID="public-report">
      {state.kind === 'loading' ? <Text style={[type.footnote, styles.line]} accessibilityLiveRegion="polite">Loading the report…</Text> : null}
      {state.kind === 'missing' ? <Callout icon="question" title="Report not found">This link does not point to a report RootCause knows about.</Callout> : null}
      {state.kind === 'failed' ? <Callout icon="offline" title="Could not load the report">Check your connection and reload the page.</Callout> : null}
      {report ? (
        <>
          <Group padded>
            <View style={styles.badges}>
              <SeverityBars band={report.severity} size="sm" />
              <Text style={type.footnote}>{RESIDENT_WORDING[report.status]}</Text>
              {report.stormSensitivity.length ? <Text style={[type.footnote, { color: colors.blue }]}>{t('feed.storm')}</Text> : null}
            </View>
            <Text style={[type.subheadline, { marginTop: 8 }]}>{report.addressText}{report.addressConfidence === 'approx' ? ' (approximate)' : ''}</Text>
          </Group>
          <SectionHeader>{t('score.title')}</SectionHeader>
          <Group padded>
            <ScoreBreakdown score={report.score} terms={report.scoreTerms} stormMultiplier={report.stormMultiplier} />
          </Group>
          <SectionHeader>What we know</SectionHeader>
          <Group>
            <KeyValue k="Sub-type" v={subtypeDef(report.subtype).label} />
            <KeyValue k="Severity" v={`${t(`severity.${report.severity}` as const)}${report.severityConfirmed ? ' · confirmed' : ` · ${t('common.notConfirmed').toLowerCase()}`}`} />
            <KeyValue k="Urgency votes" v={String(report.voteCount)} />
            <KeyValue k="Open" v={tn(daysBetween(report.createdAt, now), 'feed.daysOpen')} />
            <KeyValue k="Reported by" v={report.reporterDisplay === 'anonymous' ? 'Anonymous' : (report.reporterName ?? 'Resident')} last />
          </Group>
          <SectionHeader>{t('report.timeline')}</SectionHeader>
          <Group padded>
            <StatusTimeline status={report.status} events={report.timeline} />
          </Group>
          <Button title="Open in RootCause" icon="vote" onPress={() => void Linking.openURL(appLink(report.id)).catch(() => {})} style={{ marginTop: 8 }} testID="open-in-app" />
          <SectionFooter>Vote, follow and comment in the RootCause app. Photos are shown there after a city inspector has reviewed them.</SectionFooter>
        </>
      ) : null}
      <SectionFooter style={{ marginTop: 18 }}>RootCause · Hazard reports are public records of the city, shown here without reporter contact details or precise home locations. Map data {t('map.attribution')}.</SectionFooter>
    </Screen>
  );
}

const styles = StyleSheet.create({
  line: { paddingVertical: 12 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
});
