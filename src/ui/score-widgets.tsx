/**
 * The priority score, always shown with its five weighted terms (spec §7: "every score must render as the
 * five-term breakdown with plain-language labels wherever it appears"). The same component serves the phone
 * and the console so residents and staff read the same explanation.
 */
import { StyleSheet, Text, View } from 'react-native';

import { DEFAULT_WEIGHTS } from '@/domain/score';
import type { ScoreTerms, ScoreWeights } from '@/domain/types';
import { t } from '@/i18n';

import { ProgressBar } from './primitives';
import { colors, fonts, radius, scoreTone, tabular, toneColor, toneSoft, type } from './theme';

const ROWS: { key: keyof ScoreTerms; label: () => string; color: string }[] = [
  { key: 'severity', label: () => t('score.severity'), color: colors.amber },
  { key: 'exposure', label: () => t('score.exposure'), color: colors.blue },
  { key: 'community', label: () => t('score.community'), color: colors.brand },
  { key: 'liability', label: () => t('score.liability'), color: colors.red },
  { key: 'decay', label: () => t('score.decay'), color: colors.ink2 },
];

export function ScoreChip({ score }: { score: number }) {
  const tone = scoreTone(score);
  return (
    <View accessible accessibilityLabel={`${t('score.title')} ${Math.round(score)} ${t('score.of100')}`} style={[styles.chip, { backgroundColor: toneSoft[tone] }]}>
      <Text maxFontSizeMultiplier={1.3} style={[styles.chipText, tabular, { color: toneColor[tone] }]}>
        {Math.round(score)}
      </Text>
    </View>
  );
}

/** Five labelled bars. Each row shows the term (0–1) and its weight so the arithmetic is on screen. */
export function ScoreBreakdown({ score, terms, weights = DEFAULT_WEIGHTS, stormMultiplier = 1 }: { score: number; terms: ScoreTerms; weights?: ScoreWeights; stormMultiplier?: number }) {
  return (
    <View>
      <View style={styles.head}>
        <Text maxFontSizeMultiplier={1.4} style={[type.numerals, { fontSize: 40, lineHeight: 46 }]}>
          {Math.round(score)}
        </Text>
        <Text style={[type.footnote, { marginBottom: 6 }]}>{t('score.of100')}</Text>
      </View>
      {ROWS.map((r, i) => (
        <View key={r.key} style={[styles.row, i < ROWS.length - 1 && styles.rowGap]}>
          <View style={styles.labelRow}>
            <Text maxFontSizeMultiplier={1.6} style={type.subheadline}>
              {r.label()}
            </Text>
            <Text maxFontSizeMultiplier={1.6} style={[type.footnote, tabular, { fontFamily: fonts.sans }]}>
              {terms[r.key].toFixed(2)} × {weights[r.key].toFixed(2)}
            </Text>
          </View>
          <ProgressBar pct={Math.round(terms[r.key] * 100)} color={r.color} height={6} />
        </View>
      ))}
      {stormMultiplier !== 1 ? (
        <Text style={[type.footnote, { marginTop: 10 }]}>
          {t('score.storm')}: ×{stormMultiplier.toFixed(2)}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { minWidth: 40, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.control, alignItems: 'center' },
  chipText: { ...type.headline, fontFamily: fonts.rounded },
  head: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, marginBottom: 10 },
  row: {},
  rowGap: { marginBottom: 10 },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 },
});
