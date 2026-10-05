/**
 * Report list row, the inline urgency vote control and the status timeline (spec R1/R7 notes: voting must be
 * one tap from the feed; the timeline shows mitigation separately from the permanent fix).
 */
import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { distanceM, type LatLng } from '@/domain/geo';
import { RESIDENT_WORDING } from '@/domain/status';
import { daysBetween } from '@/domain/time';
import { REPORT_STATUSES, type PublicReport, type ReportStatus } from '@/domain/types';
import { t, tn } from '@/i18n';

import { Icon, categoryIcon, statusIcon } from './icons';
import { SeverityBadge } from './severity-widgets';
import { CELL_PAD, MIN_TAP, colors, radius, tabular, type } from './theme';

function formatDistance(m: number): string {
  return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

export function VoteControl({ count, voted, onPress, disabled, compact = false, testID }: { count: number; voted: boolean; onPress?: () => void; disabled?: boolean; compact?: boolean; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      disabled={disabled || !onPress}
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        onPress?.();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected: voted, disabled: !!disabled }}
      accessibilityLabel={t('vote.a11y', { n: count, you: voted ? t('vote.a11yYou') : '' })}
      hitSlop={6}
      style={({ pressed }) => [styles.vote, compact && styles.voteCompact, voted && styles.voteOn, pressed && { opacity: 0.6 }]}>
      <Icon name={voted ? 'vote' : 'voteOutline'} size={compact ? 14 : 16} color={voted ? colors.brandInk : colors.ink2} />
      <Text maxFontSizeMultiplier={1.3} style={[type.headline, tabular, { color: voted ? colors.brandInk : colors.ink }]}>
        {count}
      </Text>
      {compact ? null : (
        <Text maxFontSizeMultiplier={1.2} style={[type.caption2, { color: voted ? colors.brandInk : colors.ink2 }]}>
          {(voted ? t('vote.voted') : t('vote.urgent')).toUpperCase()}
        </Text>
      )}
    </Pressable>
  );
}

export function ReportRow({ report, now, from, voted, onPress, onVote, last, testID }: { report: PublicReport; /** App clock from useNow(), so demo offsets apply and render stays pure. */ now: number; from?: LatLng; voted?: boolean; onPress: () => void; onVote?: () => void; last?: boolean; testID?: string }) {
  const days = daysBetween(report.createdAt, now);
  const dist = from ? formatDistance(distanceM(from, report)) : null;
  return (
    <Pressable testID={testID} onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.row, !last && styles.rowLine, pressed && { backgroundColor: colors.bg }]}>
      <View style={styles.thumb}>
        <Icon name={categoryIcon(report.category)} size={22} color={colors.ink2} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text maxFontSizeMultiplier={1.6} style={type.headline} numberOfLines={2}>
          {report.title}
          {report.isDemo ? <Text style={[type.footnote, { color: colors.amber }]}> · {t('common.demo').toLowerCase()}</Text> : null}
        </Text>
        <Text maxFontSizeMultiplier={1.6} style={[type.footnote, { marginTop: 2 }]} numberOfLines={1}>
          {dist ? `${dist} · ` : ''}
          {report.addressText}
        </Text>
        <View style={styles.meta}>
          <SeverityBadge band={report.severity} confirmed={report.severityConfirmed} />
          <Text maxFontSizeMultiplier={1.5} style={type.footnote}>
            {tn(days, 'feed.daysOpen')} · {RESIDENT_WORDING[report.status]}
          </Text>
        </View>
      </View>
      <VoteControl count={report.voteCount} voted={!!voted} onPress={onVote} compact />
    </Pressable>
  );
}

const STEPS: ReportStatus[] = ['new', 'triaged', 'assessed', 'mitigated', 'scheduled', 'completed', 'verified'];

/** The status ladder with the reached steps filled. `rejected` is shown as its own terminal row. */
export function StatusTimeline({ status, events }: { status: ReportStatus; events: PublicReport['timeline'] }) {
  const reached = status === 'rejected' ? 0 : STEPS.indexOf(status) + 1;
  const rows = status === 'rejected' ? (['new', 'rejected'] as ReportStatus[]) : STEPS;
  return (
    <View accessibilityRole="list">
      {rows.map((s, i) => {
        const done = status === 'rejected' ? true : i < reached;
        const ev = events.find((e) => e.toStatus === s);
        return (
          <View key={s} style={[styles.step, i < rows.length - 1 && { paddingBottom: 14 }]} accessible accessibilityLabel={`${RESIDENT_WORDING[s]}, ${done ? 'done' : 'pending'}`}>
            <View style={[styles.dot, done ? styles.dotOn : styles.dotOff]}>
              <Icon name={done ? 'check' : statusIcon(s)} size={11} color={done ? colors.white : colors.ink2} weight="bold" />
            </View>
            <View style={{ flex: 1 }}>
              <Text maxFontSizeMultiplier={1.6} style={[type.subheadline, { color: done ? colors.ink : colors.ink2 }]}>
                {RESIDENT_WORDING[s]}
              </Text>
              {ev?.note ? (
                <Text maxFontSizeMultiplier={1.6} style={type.footnote}>
                  {ev.note}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export const STATUS_ORDER = REPORT_STATUSES;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: CELL_PAD, paddingVertical: 11, minHeight: MIN_TAP, backgroundColor: colors.surface },
  rowLine: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, marginLeft: 0 },
  thumb: { width: 44, height: 44, borderRadius: radius.control, backgroundColor: colors.fill, alignItems: 'center', justifyContent: 'center' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 5, flexWrap: 'wrap' },
  vote: { minWidth: 56, minHeight: MIN_TAP, alignItems: 'center', justifyContent: 'center', gap: 1, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.control, backgroundColor: colors.fill },
  voteCompact: { minWidth: 48, flexDirection: 'row', gap: 4 },
  voteOn: { backgroundColor: colors.brandSoft },
  step: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  dot: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  dotOn: { backgroundColor: colors.brand },
  dotOff: { backgroundColor: colors.fill },
});
