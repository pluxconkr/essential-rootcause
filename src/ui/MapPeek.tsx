/**
 * Peek card for the pin selected on the map (spec R2 "tap → peek card → detail"; plan §3.3): the report's title,
 * distance and address, the severity word, the score chip, votes, age and status, and an Open button. It carries the
 * text label for what the pin colour only hints at, so colour is never the only signal.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { distanceM, type LatLng } from '@/domain/geo';
import { RESIDENT_WORDING } from '@/domain/status';
import { daysBetween } from '@/domain/time';
import type { PublicReport } from '@/domain/types';
import { t, tn } from '@/i18n';

import { Icon, categoryIcon } from './icons';
import { Button } from './primitives';
import { ScoreChip } from './score-widgets';
import { SeverityBadge } from './severity-widgets';
import { CELL_PAD, MIN_TAP, colors, radius, type } from './theme';

function formatDistance(m: number): string {
  return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

export function MapPeek({ report, now, from, onOpen, onClose, testID = 'map-peek' }: { report: PublicReport; /** App clock from useNow(). */ now: number; from?: LatLng; onOpen: () => void; onClose: () => void; testID?: string }) {
  const days = daysBetween(report.createdAt, now);
  const dist = from ? formatDistance(distanceM(from, report)) : null;
  return (
    <View style={styles.card} testID={testID} accessibilityLiveRegion="polite">
      <View style={styles.head}>
        <View style={styles.thumb}>
          <Icon name={categoryIcon(report.category)} size={22} color={colors.ink2} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text maxFontSizeMultiplier={1.6} style={type.headline} numberOfLines={2} accessibilityRole="header">
            {report.title}
            {report.isDemo ? <Text style={[type.footnote, { color: colors.amber }]}> · {t('common.demo').toLowerCase()}</Text> : null}
          </Text>
          <Text maxFontSizeMultiplier={1.6} style={[type.footnote, { marginTop: 2 }]} numberOfLines={1}>
            {dist ? `${dist} · ` : ''}
            {report.addressText}
          </Text>
        </View>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} style={({ pressed }) => [styles.close, pressed && { opacity: 0.5 }]} testID={`${testID}-close`}>
          <Icon name="close" size={16} color={colors.ink2} weight="semibold" />
        </Pressable>
      </View>
      <View style={styles.meta}>
        <SeverityBadge band={report.severity} confirmed={report.severityConfirmed} />
        <ScoreChip score={report.score} />
        <Text maxFontSizeMultiplier={1.5} style={type.footnote}>
          {report.voteCount} {report.voteCount === 1 ? 'vote' : 'votes'} · {tn(days, 'feed.daysOpen')} · {RESIDENT_WORDING[report.status]}
        </Text>
      </View>
      <Button title="Open report" size="sm" variant="tonal" onPress={onOpen} style={styles.open} testID={`${testID}-open`} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.group, paddingHorizontal: CELL_PAD, paddingVertical: 12 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  thumb: { width: 44, height: 44, borderRadius: radius.control, backgroundColor: colors.fill, alignItems: 'center', justifyContent: 'center' },
  close: { width: 32, height: 32, minHeight: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.fill, marginTop: -2, marginRight: -4 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  open: { marginTop: 10, alignSelf: 'flex-start', minHeight: MIN_TAP },
});
