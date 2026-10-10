/**
 * S-10 Profile / impact (spec R13, trimmed): impact framing, not gamification — reports filed, resolved, urgency votes
 * cast (this phone's count at once; the account's count replaces it when GET /api/v1/me answers, signed in and
 * online) and the honest median time to resolve over own fixed reports, computed on this phone's copy. "Export my
 * data" fetches GET /api/v1/me/export (twice a day), writes the JSON to the app's document directory and opens the
 * share sheet. Signed-out state says what signing in unlocks; offline is a line, not an error. Links to settings,
 * offline data and privacy.
 */
import { useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useState } from 'react';

import { files } from '@/data/files';
import { DAY_MS, toEpoch } from '@/domain/time';
import type { MeProfile, PublicReport } from '@/domain/types';
import { t } from '@/i18n';
import { meApi } from '@/services/apiClient';
import { refreshProfile } from '@/services/auth';
import { demoNote } from '@/services/demo';
import { isOfflineNow, useAppState } from '@/store/appStore';
import { useMyReports, useNow, usePendingDrafts, useVantage } from '@/store/derived';
import { Screen } from '@/ui/Screen';
import { Callout, Cell, Group, KeyValue, SectionFooter, SectionHeader } from '@/ui/primitives';
import { ReportRow } from '@/ui/report-widgets';
import { colors } from '@/ui/theme';

/** "Resolved" in the impact stats: fixed, or fix confirmed (the server's RESOLVED_STATUSES, spec R13). */
const RESOLVED = new Set<PublicReport['status']>(['completed', 'verified']);

/** Median days from filing to the `completed` timeline event over own resolved reports that carry their timeline; null without one. */
export function medianResolveDays(reports: readonly PublicReport[]): number | null {
  const days = reports
    .filter((r) => RESOLVED.has(r.status))
    .map((r) => {
      const fixed = r.timeline.find((e) => e.toStatus === 'completed');
      return fixed ? (toEpoch(fixed.at) - toEpoch(r.createdAt)) / DAY_MS : null;
    })
    .filter((d): d is number => d !== null && d >= 0)
    .sort((a, b) => a - b);
  if (days.length === 0) return null;
  const mid = Math.floor(days.length / 2);
  return days.length % 2 === 1 ? days[mid] : (days[mid - 1] + days[mid]) / 2;
}

export function formatDays(days: number): string {
  if (days < 1) return 'under a day';
  const n = Math.round(days);
  return n === 1 ? '1 day' : `${n} days`;
}

type ExportState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'sign_in' } | { kind: 'done'; message: string } | { kind: 'error'; message: string };

export default function MeScreen() {
  const router = useRouter();
  const session = useAppState((s) => s.session);
  const offline = useAppState((s) => isOfflineNow(s));
  const votedCount = useAppState((s) => s.votedIds.length);
  const mine = useMyReports();
  const drafts = usePendingDrafts();
  const from = useVantage();
  const now = useNow();
  const [serverStats, setServerStats] = useState<MeProfile['stats'] | null>(null);
  const [exportState, setExportState] = useState<ExportState>({ kind: 'idle' });
  const userId = session?.userId ?? null;
  const resolved = mine.filter((r) => RESOLVED.has(r.status)).length;
  const median = useMemo(() => medianResolveDays(mine), [mine]);

  // Cache-first: the phone's own counts render at once; the account's vote count replaces it when the server answers.
  useEffect(() => {
    if (!userId || offline) return;
    let alive = true;
    void refreshProfile().then((p) => {
      if (alive && p) setServerStats(p.stats);
    });
    return () => {
      alive = false;
    };
  }, [userId, offline]);

  async function exportMyData() {
    if (!session) {
      setExportState({ kind: 'sign_in' });
      return;
    }
    setExportState({ kind: 'busy' });
    const res = await meApi.export();
    if (!res.ok) {
      // 429 carries the server's "twice a day" line; offline and timeouts say what they are.
      setExportState({ kind: 'error', message: res.message });
      return;
    }
    const name = `rootcause-export-${res.data.exportedAt.slice(0, 10)}.json`;
    const bytes = files.writeJson(name, res.data);
    if (bytes === 0) {
      setExportState({ kind: 'error', message: 'The file could not be saved on this phone. Free some space and try again.' });
      return;
    }
    setExportState({ kind: 'done', message: `Saved on this phone as ${name} (${Math.max(1, Math.round(bytes / 1024))} KB).` });
    const uri = files.uriOf(name);
    // expo-sharing hands the file itself to the sheet on both platforms (React Native's Share drops `url` on Android).
    if (uri) await Sharing.shareAsync(uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: name }).catch(() => {});
  }

  const exportBusy = exportState.kind === 'busy';
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
        <KeyValue k={t('me.votes')} v={String(serverStats?.votes ?? votedCount)} last={median === null} />
        {median !== null ? <KeyValue k={t('me.median')} v={formatDays(median)} last /> : null}
      </Group>
      <SectionFooter>
        {serverStats ? 'Votes are your account’s count. ' : 'Votes are counted on this phone. '}
        {median !== null ? t('me.medianHint') : ''}
      </SectionFooter>
      <SectionHeader>{t('me.reports')}</SectionHeader>
      <Group>
        {mine.length === 0 && drafts.length === 0 ? <Cell icon="document" iconColor={colors.ink2} title="None yet" subtitle="Reports you file appear here, including anonymous ones — the link stays on this phone." last /> : null}
        {drafts.map((d, i) => (
          <Cell key={d.id} icon={d.status === 'draft' ? 'document' : 'clock'} iconColor={colors.amber} title={d.status === 'draft' ? 'Unfinished draft' : d.status === 'needs_sign_in' ? 'Draft waiting for sign-in' : 'Draft waiting to send'} subtitle={d.status === 'draft' ? 'Not sent yet — open it to finish the three steps.' : (d.failReason ?? 'Sends automatically when you have a signal.')} accessory={d.status === 'draft' || d.status === 'failed' ? 'chevron' : 'none'} onPress={d.status === 'draft' || d.status === 'failed' ? () => router.push({ pathname: '/new/form', params: { draft: d.id } }) : undefined} last={i === drafts.length - 1 && mine.length === 0} />
        ))}
        {mine.map((r, i) => (
          <ReportRow key={r.id} report={r} now={now} from={from} onPress={() => router.push({ pathname: '/report/[id]', params: { id: r.id } })} last={i === mine.length - 1} />
        ))}
      </Group>
      <SectionHeader>Settings</SectionHeader>
      {exportState.kind === 'sign_in' ? (
        <Callout icon="signIn" tone="tint" title={t('me.exportSignIn')}>
          {t('me.exportHint')}
        </Callout>
      ) : null}
      {exportState.kind === 'error' ? (
        <Callout icon="alert" tone="amber" title="Export not ready">
          {exportState.message}
        </Callout>
      ) : null}
      {exportState.kind === 'done' ? (
        <Callout icon="checkCircle" tone="green" title="Export saved">
          {exportState.message}
        </Callout>
      ) : null}
      <Group>
        {session ? null : <Cell icon="signIn" iconColor={colors.tint} title={t('signIn.title')} subtitle={t('signIn.why')} accessory="chevron" onPress={() => router.push('/sign-in')} testID="me-sign-in" />}
        <Cell icon="bell" iconColor={colors.tint} title={t('me.settings')} accessory="chevron" onPress={() => router.push('/settings')} />
        <Cell icon="download" iconColor={colors.tint} title={t('me.data')} accessory="chevron" onPress={() => router.push('/data')} />
        <Cell icon="share" iconColor={offline ? colors.ink4 : colors.tint} title={exportBusy ? 'Preparing your export…' : t('me.export')} subtitle={offline ? 'Needs a signal' : t('me.exportHint')} onPress={offline || exportBusy ? undefined : () => void exportMyData()} testID="me-export" />
        <Cell icon="lock" iconColor={colors.tint} title={t('me.privacy')} accessory="chevron" onPress={() => router.push('/privacy')} last />
      </Group>
    </Screen>
  );
}
