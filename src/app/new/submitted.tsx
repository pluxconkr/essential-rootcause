/**
 * S-07 Submitted (spec R6; plan §9.1) — route /new/submitted?draft=<id>. Two honest states. Sent: the work order
 * with its priority score as the five weighted terms, where it ranks among the open orders of its category — computed
 * on this phone from the saved reports and labelled as such, because the server does not return a rank yet — the
 * service-level deadlines for its severity band, share, and back to the feed. Not sent yet: "Saved on this phone ·
 * sends when online" (or sign in to send / the reason it failed), never a spinner.
 */
import { useRouter } from 'expo-router';
import { Share, Text } from 'react-native';

import { rankInCategory } from '@/domain/intake';
import { SLA_STAGES, slaDeadlines } from '@/domain/sla';
import { formatDate, formatDateTime } from '@/domain/time';
import { t } from '@/i18n';
import { useAppState } from '@/store/appStore';
import { useReports } from '@/store/derived';
import { Screen, goBackOr } from '@/ui/Screen';
import { exitFlow, useDraftParam } from '@/ui/intake-widgets';
import { Button, Callout, Group, KeyValue, SectionFooter, SectionHeader } from '@/ui/primitives';
import { ScoreBreakdown } from '@/ui/score-widgets';
import { severityLabel } from '@/ui/severity-widgets';
import { colors, type } from '@/ui/theme';

const STAGE_HINT = { ack: 'City acknowledges the report', assess: 'Inspector assesses it in the field', mitigate: 'Made safe temporarily', fix: 'Permanent fix' } as const;

export default function SubmittedScreen() {
  const router = useRouter();
  const draft = useDraftParam();
  const report = useAppState((s) => (draft?.reportId ? (s.feed.find((r) => r.id === draft.reportId) ?? null) : null));
  const reports = useReports();

  if (!draft) {
    return (
      <Screen title={t('submitted.title')} testID="submitted">
        <Callout icon="info" title="Draft not found">This draft is no longer on this phone.</Callout>
        <Button title={t('common.back')} variant="secondary" onPress={() => goBackOr(router, '/')} />
      </Screen>
    );
  }

  if (draft.status === 'sent' && report) {
    const { rank, total } = rankInCategory(reports, report);
    const deadlines = slaDeadlines(report.createdAt, report.severity);
    return (
      <Screen title={t('submitted.title')} largeTitle={t('submitted.created')} testID="submitted-created">
        <Callout icon="checkCircle" tone="green" title={report.title}>
          {`${report.addressText || 'Location from your GPS fix'}${report.addressConfidence === 'approx' ? ' (approximate)' : ''} · filed ${formatDateTime(report.createdAt)}`}
        </Callout>

        <SectionHeader>{t('score.title')}</SectionHeader>
        <Group padded>
          <ScoreBreakdown score={report.score} terms={report.scoreTerms} stormMultiplier={report.stormMultiplier} />
          <Text style={[type.subheadline, { marginTop: 12, color: colors.ink }]} testID="submitted-rank">
            {`Ranks ${t('submitted.rank', { rank, total }).replace(/^ranks /, '')}`}
          </Text>
        </Group>
        <SectionFooter>Rank computed on this phone from the {reports.length} saved reports; the city queue may differ. {t('score.whyBody')}</SectionFooter>

        <SectionHeader>{t('submitted.next')}</SectionHeader>
        <Group>
          {SLA_STAGES.map((stage, i) => (
            <KeyValue key={stage} k={STAGE_HINT[stage]} v={deadlines[stage] === null ? 'No deadline for this band' : `by ${formatDate(deadlines[stage]!, { month: 'short', day: 'numeric', year: 'numeric' })}`} last={i === SLA_STAGES.length - 1} />
          ))}
        </Group>
        <SectionFooter>City service levels for a {severityLabel(report.severity).toLowerCase()} hazard, counted from when you filed. You get a status update at each step{report.reporterDisplay === 'anonymous' ? ' — except on anonymous reports, which cannot receive updates' : ''}.</SectionFooter>

        <Button title={t('submitted.share')} icon="share" onPress={() => void Share.share({ message: `${report.title} — ${report.addressText}. Priority score ${Math.round(report.score)}/100. Add your urgency vote in RootCause.` }).catch(() => {})} />
        <Button title="Open the report" variant="secondary" icon="document" onPress={() => router.replace({ pathname: '/report/[id]', params: { id: report.id } })} style={{ marginTop: 8 }} />
        <Button title={t('submitted.back')} variant="ghost" onPress={() => exitFlow(router)} style={{ marginTop: 8 }} testID="submitted-back" />
      </Screen>
    );
  }

  const line = draft.status === 'needs_sign_in' ? 'Saved on this phone · sign in to send it' : draft.status === 'failed' ? `Not sent: ${draft.failReason ?? 'the server refused it'}` : t('submitted.queued');
  const body =
    draft.status === 'needs_sign_in'
      ? 'Sign in from the Me tab and this report sends by itself. Nothing is lost.'
      : draft.status === 'failed'
        ? 'Open the draft from the Me tab to fix the details and send it again.'
        : 'It sends automatically when you have a signal. You can keep using the app; the photo and your answers are safe on this phone.';
  return (
    <Screen title={t('submitted.title')} largeTitle={t('submitted.title')} testID="submitted-queued">
      <Callout icon={draft.status === 'failed' ? 'alert' : 'clock'} tone={draft.status === 'failed' ? 'red' : 'amber'} title={line}>
        {body}
      </Callout>
      <Group>
        <KeyValue k="Captured" v={formatDateTime(draft.capturedAt)} />
        <KeyValue k="Photo" v={draft.photoUris.length ? (draft.photoIds?.length ? 'uploaded' : 'saved on this phone') : 'none'} />
        <KeyValue k="Identity" v={draft.form.reporterDisplay ? t(`form.identity.${draft.form.reporterDisplay}` as const) : t('form.identity.named')} last />
      </Group>
      <Button title={t('submitted.back')} icon="home" onPress={() => exitFlow(router)} testID="submitted-back" />
    </Screen>
  );
}
