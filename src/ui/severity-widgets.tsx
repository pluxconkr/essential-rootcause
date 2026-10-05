/**
 * Severity, never colour alone: `SeverityBars` shows n of 4 filled bars with the band word, and VoiceOver
 * reads "High, 3 of 4" (spec §12: no colour-only encoding of severity). Tones follow the spec badge mapping
 * (Low grey · Moderate blue · High amber · Critical red).
 */
import { StyleSheet, Text, View } from 'react-native';

import type { SeverityBand } from '@/domain/types';
import { t } from '@/i18n';

import { colors, radius, severityTone, toneColor, toneSoft, type } from './theme';

export function severityLabel(band: SeverityBand): string {
  return t(`severity.${band}` as const);
}

export function SeverityBars({ band, size = 'md', muted = false }: { band: SeverityBand; size?: 'sm' | 'md' | 'lg'; muted?: boolean }) {
  const tone = severityTone[band];
  const h = size === 'lg' ? 18 : size === 'md' ? 14 : 10;
  const w = size === 'lg' ? 7 : size === 'md' ? 5 : 4;
  const label = severityLabel(band);
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={t('severity.a11y', { label, n: band })} style={styles.row}>
      <View style={[styles.bars, { height: h }]}>
        {[1, 2, 3, 4].map((i) => (
          <View key={i} style={{ width: w, height: h * (0.4 + i * 0.15), borderRadius: 2, backgroundColor: i <= band ? (muted ? colors.ink4 : toneColor[tone]) : colors.fill }} />
        ))}
      </View>
      <Text maxFontSizeMultiplier={1.5} style={[size === 'lg' ? type.headline : size === 'md' ? type.subheadline : type.caption, { color: muted ? colors.ink2 : colors.ink }]}>
        {label}
      </Text>
    </View>
  );
}

/** Compact pill with the band word. Used in rows where the bars would not fit. */
export function SeverityBadge({ band, confirmed }: { band: SeverityBand; confirmed?: boolean }) {
  const tone = severityTone[band];
  const label = severityLabel(band);
  return (
    <View accessible accessibilityLabel={`${label}${confirmed ? '' : `, ${t('common.notConfirmed')}`}`} style={[styles.badge, { backgroundColor: toneSoft[tone] }]}>
      <Text maxFontSizeMultiplier={1.3} style={[type.caption2, { color: toneColor[tone] }]}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  badge: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.tag, alignSelf: 'flex-start' },
});
