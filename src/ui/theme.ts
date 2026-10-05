/**
 * Design tokens — native iOS idiom (grouped inset lists, SF Pro, one accent), light only.
 *
 * One accent: RootCause green (brand) is the tint and also the "good / verified" colour.
 * Semantic colours: red = critical / emergency / SLA breached; amber = high severity, at risk, stale data;
 * blue = storm and forecast context, and moderate severity (the spec's own badge mapping).
 * Severity is never colour alone: SeverityBars shows "n of 4" with a label wherever a colour appears.
 * Surfaces follow iOS system grouped backgrounds so the app reads like a first-party utility.
 */
import { Platform, type TextStyle } from 'react-native';

export const palette = {
  brand: '#1F6B4F', // spec --brand; ≈ 6.4:1 on white, usable for text and icons
  brandLight: '#2F8C66', // spec --brand-2; ≈ 4.1:1 — fills and large glyphs only, never body text
  brandFill: '#E4F2EA', // spec --brand-soft
  brandInk: '#0F3D2C', // spec --brand-ink
  blue: '#2B5F9E', // spec --blue; ≈ 6.8:1
  blueFill: '#E7EFFA',
  red: '#B3261E', // sibling red (the spec's #b23b30 is close; keep the family value)
  redFill: '#FBE9E7',
  amber: '#8A5A00', // sibling amber; the spec's #b8791a is 3.6:1 and fails AA for text
  amberFill: '#FFF3DB',
  label: '#0B0F19',
  secondaryLabel: 'rgba(60,60,67,0.75)', // iOS uses 0.60 (3.4:1); 0.75 clears WCAG AA 4.5:1 on both surfaces
  tertiaryLabel: 'rgba(60,60,67,0.30)',
  separator: 'rgba(60,60,67,0.16)',
  groupedBackground: '#F2F2F7',
  secondaryGroupedBackground: '#FFFFFF',
  fill: 'rgba(120,120,128,0.12)',
  white: '#FFFFFF',
} as const;

/** Semantic aliases used by screens. `navy*` names are kept so the shared primitives read unchanged. */
export const colors = {
  brand: palette.brand,
  navy: palette.brand,
  tint: palette.brand,
  navySoft: palette.brandFill,
  brandSoft: palette.brandFill,
  brandInk: palette.brandInk,
  blue: palette.blue,
  blueSoft: palette.blueFill,
  red: palette.red,
  redSoft: palette.redFill,
  green: palette.brand,
  greenSoft: palette.brandFill,
  amber: palette.amber,
  amberSoft: palette.amberFill,
  ink: palette.label,
  ink2: palette.secondaryLabel,
  ink4: palette.tertiaryLabel,
  line: palette.separator,
  bg: palette.groupedBackground,
  surface: palette.secondaryGroupedBackground,
  fill: palette.fill,
  offlineBar: '#E5E5EA',
  offlineText: 'rgba(60,60,67,0.85)',
  white: palette.white,
  onDark: 'rgba(255,255,255,0.72)',
} as const;

export type Tone = 'grey' | 'blue' | 'amber' | 'red' | 'green';

/** Tones → colours. A tone is never the only signal: the bar count and label always accompany it. */
export const toneColor: Record<Tone, string> = { grey: colors.ink2, blue: colors.blue, amber: colors.amber, red: colors.red, green: colors.green };
export const toneSoft: Record<Tone, string> = { grey: colors.fill, blue: colors.blueSoft, amber: colors.amberSoft, red: colors.redSoft, green: colors.greenSoft };

/** Severity band 1–4 → tone (spec badge mapping: Low grey, Moderate blue, High amber, Critical red). */
export const severityTone: Record<1 | 2 | 3 | 4, Tone> = { 1: 'grey', 2: 'blue', 3: 'amber', 4: 'red' };

/** Score chip thresholds (console and detail): ≥85 red, ≥75 amber, ≥60 blue, else grey. */
export function scoreTone(score: number): Tone {
  return score >= 85 ? 'red' : score >= 75 ? 'amber' : score >= 60 ? 'blue' : 'grey';
}

export const fonts = {
  sans: Platform.select({ ios: 'System', android: 'sans-serif', default: 'System' }),
  /** Big numerals (score): SF Rounded on iOS, system elsewhere. Always tabular. */
  rounded: Platform.select({ ios: 'ui-rounded', android: 'sans-serif', default: 'System' }),
} as const;

/** Tabular figures so digits never jitter. */
export const tabular: TextStyle = { fontVariant: ['tabular-nums'] };

export const radius = { group: 12, button: 12, tag: 6, control: 8 } as const;

/** Horizontal page margin (iOS inset grouped). */
export const GUTTER = 16;
/** Minimum touch target (pt). */
export const MIN_TAP = 44;
/** Cell horizontal padding inside a group. */
export const CELL_PAD = 16;

/** iOS text styles (sizes at default Dynamic Type). Body ≥ 15. */
export const type = {
  largeTitle: { fontSize: 28, lineHeight: 34, fontWeight: '700' as const, letterSpacing: -0.4, color: colors.ink },
  title1: { fontSize: 26, lineHeight: 32, fontWeight: '700' as const, letterSpacing: -0.3, color: colors.ink },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: '700' as const, letterSpacing: -0.2, color: colors.ink },
  title3: { fontSize: 20, lineHeight: 25, fontWeight: '600' as const, letterSpacing: -0.2, color: colors.ink },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' as const, letterSpacing: -0.41, color: colors.ink },
  body: { fontSize: 17, lineHeight: 22, fontWeight: '400' as const, letterSpacing: -0.41, color: colors.ink },
  callout: { fontSize: 16, lineHeight: 21, fontWeight: '400' as const, letterSpacing: -0.32, color: colors.ink },
  subheadline: { fontSize: 15, lineHeight: 20, fontWeight: '400' as const, letterSpacing: -0.24, color: colors.ink2 },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const, letterSpacing: -0.08, color: colors.ink2 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' as const, color: colors.ink2 },
  sectionHeader: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const, letterSpacing: -0.08, textTransform: 'uppercase' as const, color: colors.ink2 },
  /** The severity word on a report ("High"). */
  display: { fontSize: 34, lineHeight: 40, fontWeight: '700' as const, letterSpacing: -0.4, color: colors.ink },
  /** Score numerals. */
  numerals: { fontFamily: fonts.rounded, fontSize: 52, lineHeight: 60, fontWeight: '600' as const, letterSpacing: -0.5, color: colors.ink },
  caption2: { fontSize: 11, lineHeight: 13, fontWeight: '600' as const, color: colors.ink2 },
  /** Segmented-control labels; `controlSmall` when four or more options share the row. */
  control: { fontSize: 15, lineHeight: 20, fontWeight: '500' as const, color: colors.ink },
  controlSmall: { fontSize: 13, lineHeight: 18, fontWeight: '500' as const, color: colors.ink },
  /** Tab bar labels do not scale, like UIKit. */
  tabLabel: { fontSize: 10.5, fontWeight: '500' as const },
  /** Map chrome (no Dynamic Type). */
  mapLabel: { fontSize: 9.5, lineHeight: 12, fontWeight: '600' as const, color: colors.ink2 },
  mapAttribution: { fontSize: 9.5, lineHeight: 12, fontWeight: '400' as const, color: colors.ink2 },
  mapTag: { fontSize: 13, lineHeight: 18, fontWeight: '600' as const, letterSpacing: -0.08, color: colors.ink2 },
  mapPin: { fontSize: 10, fontWeight: '800' as const },
  legend: { fontSize: 12.5, lineHeight: 16, fontWeight: '600' as const, color: colors.ink2 },
  chartAxis: { fontSize: 10, fontWeight: '400' as const, color: colors.ink2 },
} as const;
