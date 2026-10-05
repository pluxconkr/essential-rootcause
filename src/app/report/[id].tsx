/**
 * S-08 Report detail (spec R7): the social object of the app. Evidence, the resident's note, the vote with its visible
 * threshold, the score with all five terms, the honest status timeline, comments (a public record), nearby related
 * orders, share, follow and flag. Everything renders from local data; online, the comments are fetched into component
 * state and a report missing from the cache (a push deep link) is fetched once. Votes, follows, comments and flags go
 * through services/engagement: optimistic, queued offline, sign-in asked first (plan §9.2).
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';

import { distanceM } from '@/domain/geo';
import { RESIDENT_WORDING } from '@/domain/status';
import { subtypeDef } from '@/domain/taxonomy';
import { daysBetween, formatDateTime } from '@/domain/time';
import { FLAG_REASONS, type Comment, type FlagInput } from '@/domain/types';
import { VOTE_THRESHOLDS } from '@/domain/votes';
import { t, tn } from '@/i18n';
import * as engagement from '@/services/engagement';
import { actions, isOfflineNow, useAppState } from '@/store/appStore';
import { useNow, useReport, useReports, useVantage } from '@/store/derived';
import { Screen } from '@/ui/Screen';
import { Icon, categoryIcon } from '@/ui/icons';
import { Button, Callout, Cell, Field, Group, KeyValue, ProgressBar, SectionFooter, SectionHeader, Segmented } from '@/ui/primitives';
import { ReportRow, StatusTimeline, VoteControl } from '@/ui/report-widgets';
import { ScoreBreakdown } from '@/ui/score-widgets';
import { SeverityBars } from '@/ui/severity-widgets';
import { colors, type } from '@/ui/theme';

const FLAG_LABEL: Record<FlagInput['reason'], string> = { privacy: 'Privacy', abuse: 'Abusive', wrong_place: 'Wrong place', spam: 'Spam', other: 'Other' };

export default function ReportDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const report = useReport(id);
  const all = useReports();
  const from = useVantage();
  const now = useNow();
  const offline = useAppState((s) => isOfflineNow(s));
  const voted = useAppState((s) => (id ? s.votedIds.includes(id) : false));
  const following = useAppState((s) => (id ? s.followedIds.includes(id) : false));
  const [needSignIn, setNeedSignIn] = useState<string | null>(null);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [draft, setDraft] = useState('');
  const [commentNote, setCommentNote] = useState<string | null>(null);
  const [flagOpen, setFlagOpen] = useState(false);
  const [flagReason, setFlagReason] = useState<FlagInput['reason']>('privacy');
  const [flagNote, setFlagNote] = useState<string | null>(null);
  const lookupRef = useRef<string | null>(null);
  const [lookupFailed, setLookupFailed] = useState(false);

  const reportId = report?.id ?? null;
  const isDemo = report?.isDemo === true;

  // Online: the comments live on the server; offline they are simply not shown (the count still is).
  useEffect(() => {
    if (!reportId || offline || isDemo) return;
    let alive = true;
    void engagement.fetchComments(reportId).then((list) => {
      if (alive && list) setComments(list);
    });
    return () => {
      alive = false;
    };
  }, [reportId, offline, isDemo]);

  // A deep link to a report that is not cached (status push, share link): fetch it once when online.
  useEffect(() => {
    if (report || !id || offline || lookupRef.current === id) return;
    lookupRef.current = id;
    void engagement.fetchReport(id).then((res) => {
      if (res.report) actions.upsertReport(res.report);
      else setLookupFailed(true);
    });
  }, [report, id, offline]);

  if (!report) {
    return (
      <Screen title={t('report.title')} testID="report-detail">
        <Callout icon="info" title="Report not found">{offline ? 'This report is not saved on this phone. Connect and refresh to load it.' : lookupFailed ? 'This report is not saved on this phone and the server does not list it.' : 'Loading the report…'}</Callout>
      </Screen>
    );
  }

  const nearby = all.filter((o) => o.id !== report.id && distanceM(o, report) <= 300).slice(0, 3);
  const need = VOTE_THRESHOLDS.supervisorReview;
  const shown = comments ?? [];

  async function onVote() {
    const res = await engagement.vote(report!.id, !voted);
    if (!res.ok && res.reason === 'sign_in') setNeedSignIn(t('vote.signIn'));
  }

  async function onFollow() {
    const res = await engagement.follow(report!.id, !following);
    if (!res.ok && res.reason === 'sign_in') setNeedSignIn('Sign in to follow');
  }

  async function onSend() {
    const res = await engagement.comment(report!.id, draft);
    if (!res.ok) {
      if (res.reason === 'sign_in') setNeedSignIn('Sign in to comment');
      else setCommentNote(res.message);
      return;
    }
    setDraft('');
    if (res.comment) setComments([...(comments ?? []), res.comment]);
    setCommentNote(res.queued ? 'Saved on this phone · sends when online' : null);
  }

  async function onFlag() {
    const res = await engagement.flag({ type: 'report', id: report!.id }, flagReason);
    if (!res.ok && res.reason === 'sign_in') {
      setNeedSignIn('Sign in to flag a post');
      return;
    }
    setFlagNote(res.ok ? 'Thanks — a moderator will look at this post.' : res.message);
    if (res.ok) setFlagOpen(false);
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
          <VoteControl count={report.voteCount} voted={voted} onPress={() => void onVote()} testID="vote" />
          <View style={{ flex: 1 }}>
            <ProgressBar pct={Math.min(100, Math.round((report.voteCount / need) * 100))} color={colors.brand} height={6} />
            <Text style={[type.footnote, { marginTop: 4 }]}>{report.voteCount >= need ? t('vote.thresholdPassed') : t('vote.threshold', { n: report.voteCount, need })}</Text>
          </View>
        </View>
        {needSignIn ? <Callout icon="signIn" tone="tint" title={needSignIn} style={{ marginTop: 10 }}>{t('me.signedOut')}</Callout> : null}
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
        <KeyValue k="Reported by" v={report.reporterDisplay === 'anonymous' ? 'Anonymous' : (report.reporterName ?? 'Resident')} last={!report.summary} />
        {report.summary ? (
          <View style={styles.summary}>
            <Text style={type.footnote}>From the reporter</Text>
            <Text style={[type.body, { marginTop: 2 }]} testID="report-summary">{report.summary}</Text>
          </View>
        ) : null}
      </Group>

      <SectionHeader>{t('report.timeline')}</SectionHeader>
      <Group padded>
        <StatusTimeline status={report.status} events={report.timeline} />
      </Group>
      <SectionFooter>“Made safe temporarily” is shown separately from the permanent fix: a cone or a wedge stops the clock, it does not close the order.</SectionFooter>

      <SectionHeader right={String(Math.max(report.commentCount, shown.length))}>{t('report.comments')}</SectionHeader>
      <Group>
        {shown.length === 0 ? <Cell icon="comment" iconColor={colors.ink2} title={offline && !isDemo ? 'Comments load when you have a signal' : 'No comments yet'} subtitle={isDemo ? 'Demo report · comments you add here stay on this phone.' : 'Comments are a public record. Keep them about the spot.'} last /> : null}
        {shown.map((c, i) => (
          <Cell key={c.id} icon={c.isStaff ? 'shield' : 'person'} iconColor={c.isStaff ? colors.tint : colors.ink2} title={c.body} subtitle={`${c.authorDisplay}${c.isStaff ? ' · City staff' : ''} · ${formatDateTime(c.at)}`} last={i === shown.length - 1} />
        ))}
      </Group>
      <Group>
        <Field icon="comment" value={draft} onChangeText={setDraft} placeholder="Add a comment for your neighbours" maxLength={1000} returnKeyType="send" onSubmitEditing={() => void onSend()} testID="comment-input" last />
      </Group>
      <Button title="Send" variant="secondary" icon="comment" onPress={() => void onSend()} disabled={draft.trim().length === 0} testID="comment-send" />
      {commentNote ? <SectionFooter>{commentNote}</SectionFooter> : null}

      {nearby.length ? (
        <>
          <SectionHeader>{t('report.nearby')}</SectionHeader>
          <Group>
            {nearby.map((o, i) => <ReportRow key={o.id} report={o} now={now} from={from} onPress={() => router.push({ pathname: '/report/[id]', params: { id: o.id } })} last={i === nearby.length - 1} />)}
          </Group>
        </>
      ) : null}

      <Button title={t('report.share')} icon="share" onPress={() => void Share.share({ message: `${report.title} — ${report.addressText}. Priority score ${Math.round(report.score)}/100. Add your urgency vote in RootCause.` }).catch(() => {})} style={{ marginTop: 8 }} />
      <Button title={following ? t('report.following') : t('report.follow')} variant={following ? 'tonal' : 'secondary'} icon={following ? 'bell' : 'bellOutline'} onPress={() => void onFollow()} style={{ marginTop: 8 }} testID="follow" />

      <Group style={{ marginTop: 18 }}>
        <Cell icon="flag" iconColor={colors.ink2} title={t('report.flag')} accessory={flagOpen ? 'none' : 'chevron'} onPress={() => setFlagOpen((v) => !v)} last={!flagOpen} testID="flag-toggle" />
        {flagOpen ? (
          <View style={styles.flagBox}>
            <Segmented options={FLAG_REASONS.map((r) => ({ value: r, label: FLAG_LABEL[r] }))} value={flagReason} onChange={setFlagReason} label="Reason" />
            <Button title={`Flag as ${FLAG_LABEL[flagReason].toLowerCase()}`} variant="red" size="sm" icon="flag" onPress={() => void onFlag()} style={{ marginTop: 10, alignSelf: 'flex-start' }} testID="flag-send" />
          </View>
        ) : null}
      </Group>
      {flagNote ? <SectionFooter>{flagNote}</SectionFooter> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  photo: { height: 150, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.fill, paddingHorizontal: 24 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' },
  voteRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  summary: { paddingVertical: 10, paddingRight: 16 },
  flagBox: { paddingHorizontal: 16, paddingBottom: 14 },
});
