/**
 * S-10 Profile / impact (spec R13, trimmed). Impact framing, not gamification: reports filed, resolved, votes.
 * Signed-out state says what signing in unlocks. Links to data, privacy; alert rules arrive in M1.
 */
import { useRouter } from 'expo-router';

import { t } from '@/i18n';
import { demoNote } from '@/services/demo';
import { useAppState } from '@/store/appStore';
import { useMyReports, useNow, usePendingDrafts, useVantage } from '@/store/derived';
import { Screen } from '@/ui/Screen';
import { Callout, Cell, Group, KeyValue, SectionHeader } from '@/ui/primitives';
import { ReportRow } from '@/ui/report-widgets';
import { colors } from '@/ui/theme';

export default function MeScreen() {
  const router = useRouter();
  const session = useAppState((s) => s.session);
  const mine = useMyReports();
  const drafts = usePendingDrafts();
  const from = useVantage();
  const now = useNow();
  const resolved = mine.filter((r) => r.status === 'completed' || r.status === 'verified').length;
  return (
    <Screen largeTitle={session?.displayName ?? t('me.title')} note={demoNote()} testID="me">
      {session ? null : (
        <Callout icon="signIn" tone="tint" title={t('me.signedOut')}>
          One vote per person, and your reports stay yours when you change phones. Browsing never needs an account.
        </Callout>
      )}
      <SectionHeader>{t('me.impact')}</SectionHeader>
      <Group>
        <KeyValue k={t('me.filed')} v={String(mine.length + drafts.length)} />
        <KeyValue k={t('me.resolved')} v={String(resolved)} />
        <KeyValue k={t('me.votes')} v="0" last />
      </Group>
      <SectionHeader>{t('me.reports')}</SectionHeader>
      <Group>
        {mine.length === 0 && drafts.length === 0 ? <Cell icon="document" iconColor={colors.ink2} title="None yet" subtitle="Reports you file appear here, including anonymous ones — the link stays on this phone." last /> : null}
        {drafts.map((d, i) => (
          <Cell key={d.id} icon="clock" iconColor={colors.amber} title="Draft waiting to send" subtitle={d.failReason ?? 'Sends automatically when you have a signal.'} last={i === drafts.length - 1 && mine.length === 0} />
        ))}
        {mine.map((r, i) => (
          <ReportRow key={r.id} report={r} now={now} from={from} onPress={() => router.push({ pathname: '/report/[id]', params: { id: r.id } })} last={i === mine.length - 1} />
        ))}
      </Group>
      <SectionHeader>Settings</SectionHeader>
      <Group>
        {session ? null : <Cell icon="signIn" iconColor={colors.tint} title={t('signIn.title')} subtitle={t('signIn.why')} accessory="chevron" onPress={() => router.push('/sign-in')} testID="me-sign-in" />}
        <Cell icon="bell" iconColor={colors.tint} title={t('me.settings')} accessory="chevron" onPress={() => router.push('/settings')} />
        <Cell icon="download" iconColor={colors.tint} title={t('me.data')} accessory="chevron" onPress={() => router.push('/data')} />
        <Cell icon="lock" iconColor={colors.tint} title={t('me.privacy')} accessory="chevron" onPress={() => router.push('/privacy')} last />
      </Group>
    </Screen>
  );
}
