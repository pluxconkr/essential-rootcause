/**
 * Building blocks in the iOS grouped-list idiom. No shadows, no borders, no icon backgrounds.
 * 44pt targets, body ≥ 15pt, tabular numerals. No spinners anywhere.
 */
import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type PressableProps, type StyleProp, type TextInputProps, type TextProps, type TextStyle, type ViewStyle } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { t } from '@/i18n';

import { Icon, type IconName } from './icons';
import { CELL_PAD, MIN_TAP, colors, fonts, radius, tabular, type } from './theme';

// ---------- Text ----------

type TP = TextProps & { children: ReactNode; style?: StyleProp<TextStyle> };

export const LargeTitle = ({ children, style, ...r }: TP) => <Text accessibilityRole="header" style={[type.largeTitle, style]} {...r}>{children}</Text>;
export const Title1 = ({ children, style, ...r }: TP) => <Text accessibilityRole="header" style={[type.title1, style]} {...r}>{children}</Text>;
export const Title2 = ({ children, style, ...r }: TP) => <Text accessibilityRole="header" style={[type.title2, style]} {...r}>{children}</Text>;
export const Title3 = ({ children, style, ...r }: TP) => <Text accessibilityRole="header" style={[type.title3, style]} {...r}>{children}</Text>;
export const Headline = ({ children, style, ...r }: TP) => <Text style={[type.headline, style]} {...r}>{children}</Text>;
export const Body = ({ children, style, strong, ...r }: TP & { strong?: boolean }) => <Text style={[strong ? type.headline : type.body, style]} {...r}>{children}</Text>;
export const CalloutText = ({ children, style, ...r }: TP) => <Text style={[type.callout, style]} {...r}>{children}</Text>;
export const Subhead = ({ children, style, ...r }: TP) => <Text style={[type.subheadline, style]} {...r}>{children}</Text>;
export const Footnote = ({ children, style, ...r }: TP) => <Text style={[type.footnote, style]} {...r}>{children}</Text>;
export const Caption = ({ children, style, ...r }: TP) => <Text style={[type.caption, style]} {...r}>{children}</Text>;
/** Back-compat aliases. */
export const H1 = Title1;
export const H2 = Title2;
export const H3 = Headline;
export const Small = Subhead;
export const Xs = Footnote;

/** iOS grouped-list section header: small uppercase secondary text with inset. Optional trailing text. */
export function SectionHeader({ children, right, style }: { children: ReactNode; right?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.sectionHeader, style]}>
      <Text style={type.sectionHeader}>{children}</Text>
      {right ? <View>{typeof right === 'string' ? <Text style={type.sectionHeader}>{right}</Text> : right}</View> : null}
    </View>
  );
}
/** Back-compat alias. */
export const SectionLabel = SectionHeader;

/** Footer text under a group. */
export function SectionFooter({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[type.footnote, styles.sectionFooter, style]}>{children}</Text>;
}

/** Title-style section heading (bold) used between groups on content-heavy screens. */
export function SectionTitle({ children, hint, right }: { children: ReactNode; hint?: string; right?: ReactNode }) {
  return (
    <View style={styles.sectionTitleRow}>
      <View style={{ flex: 1 }}>
        <Text style={type.title3}>{children}</Text>
        {hint ? <Text style={[type.footnote, { marginTop: 2 }]}>{hint}</Text> : null}
      </View>
      {right}
    </View>
  );
}

// ---------- Surfaces ----------

export type Tone = 'default' | 'red' | 'green' | 'amber' | 'navy' | 'tint';

/** Inset grouped container (white, 12pt radius). Children are usually Cells or padded content. */
export function Group({ children, style, padded = false }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  return <View style={[styles.group, padded && styles.groupPadded, style]}>{children}</View>;
}
/** Back-compat: Card = padded Group. */
export function Card({ children, style, padded = true, onPress, testID }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean; onPress?: () => void; testID?: string }) {
  const inner = <Group padded={padded} style={style}>{children}</Group>;
  if (!onPress) return inner;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" testID={testID} style={({ pressed }) => pressed && styles.pressed}>
      {inner}
    </Pressable>
  );
}

/**
 * A grouped-list cell: optional leading icon (tinted, no background), title + subtitle,
 * trailing value and/or chevron. Separator is inset to the title edge, like UIKit.
 */
export function Cell({
  icon,
  iconColor = colors.tint,
  title,
  subtitle,
  value,
  valueColor,
  accessory = 'none',
  onPress,
  leading,
  trailing,
  last,
  tone,
  testID,
  accessibilityLabel,
  accessibilityRole,
  accessibilityState,
}: {
  icon?: IconName;
  iconColor?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  value?: string;
  valueColor?: string;
  accessory?: 'none' | 'chevron' | 'check';
  onPress?: () => void;
  leading?: ReactNode;
  trailing?: ReactNode;
  last?: boolean;
  tone?: 'default' | 'green';
  testID?: string;
  accessibilityLabel?: string;
  accessibilityRole?: 'button' | 'checkbox' | 'link';
  accessibilityState?: PressableProps['accessibilityState'];
}) {
  const content = (
    <View style={[styles.cell, tone === 'green' && { backgroundColor: colors.greenSoft }]}>
      {leading ? <View style={styles.cellIcon}>{leading}</View> : icon ? <Icon name={icon} size={22} color={iconColor} style={styles.cellIcon} /> : null}
      <View style={[styles.cellBody, !last && styles.cellSeparator]}>
        <View style={{ flex: 1 }}>
          {typeof title === 'string' ? (
            <Text style={type.body}>
              {title}
            </Text>
          ) : (
            title
          )}
          {subtitle ? typeof subtitle === 'string' ? <Text style={[type.footnote, { marginTop: 2 }]}>{subtitle}</Text> : subtitle : null}
        </View>
        {value ? <Text maxFontSizeMultiplier={1.4} style={[styles.cellValue, tabular, valueColor ? { color: valueColor } : null]}>{value}</Text> : null}
        {trailing}
        {accessory === 'chevron' ? <Icon name="chevron" size={14} color={colors.ink4} weight="semibold" style={{ marginLeft: 6 }} /> : null}
        {accessory === 'check' ? <Icon name="check" size={17} color={colors.tint} weight="semibold" style={{ marginLeft: 6 }} /> : null}
      </View>
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable onPress={onPress} accessibilityRole={accessibilityRole ?? 'button'} accessibilityLabel={accessibilityLabel} accessibilityState={accessibilityState} testID={testID} style={({ pressed }) => pressed && styles.cellPressed}>
      {content}
    </Pressable>
  );
}

export function ProgressRing({ pct, size = 56, stroke = 6, color = colors.green, track = colors.fill, children }: { pct: number; size?: number; stroke?: number; color?: string; track?: string; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }} accessibilityRole="progressbar" accessibilityValue={{ now: clamped, min: 0, max: 100 }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={`${c} ${c}`} strokeDashoffset={c * (1 - clamped / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </Svg>
      {children}
    </View>
  );
}

export function ProgressBar({ pct, color = colors.green, label, height = 4 }: { pct: number; color?: string; label?: string; height?: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <View style={[styles.progress, { height }]} accessibilityRole="progressbar" accessibilityValue={{ now: clamped, min: 0, max: 100, text: label ?? `${clamped}%` }}>
      <View style={[styles.progressFill, { width: `${clamped}%`, backgroundColor: color }]} />
    </View>
  );
}

export function Divider({ inset = CELL_PAD }: { inset?: number }) {
  return <View style={[styles.divider, { marginLeft: inset }]} />;
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.hrow, style]}>{children}</View>;
}

/** Tinted callout with an inline icon: warnings, notes, empty states. */
export function Callout({ icon, title, children, tone = 'tint', color, style }: { icon: IconName; title?: string; children?: ReactNode; tone?: Tone; color?: string; style?: StyleProp<ViewStyle> }) {
  const fg = color ?? { default: colors.ink2, red: colors.red, green: colors.green, amber: colors.amber, navy: colors.navy, tint: colors.tint }[tone];
  return (
    <Group padded style={style}>
      <View style={styles.calloutRow}>
        <Icon name={icon} size={22} color={fg} style={{ marginTop: 1 }} />
        <View style={{ flex: 1 }}>
          {title ? <Text style={type.headline}>{title}</Text> : null}
          {children ? <View style={title ? { marginTop: 3 } : undefined}>{typeof children === 'string' ? <Text style={type.subheadline}>{children}</Text> : children}</View> : null}
        </View>
      </View>
    </Group>
  );
}
/** Back-compat alias. */
export const Notice = Callout;

// ---------- Controls ----------

export function Button({
  title,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  style,
  accessibilityHint,
  testID,
  size = 'md',
}: {
  title: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'tonal' | 'red' | 'green' | 'ghost' | 'onDark';
  icon?: IconName;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
  testID?: string;
  size?: 'md' | 'sm';
}) {
  const bg = { primary: colors.tint, secondary: colors.fill, tonal: colors.navySoft, red: colors.red, green: colors.green, ghost: 'transparent', onDark: 'rgba(255,255,255,0.18)' }[variant];
  const fg = { primary: colors.white, secondary: colors.tint, tonal: colors.tint, red: colors.white, green: colors.white, ghost: colors.tint, onDark: colors.white }[variant];
  return (
    <Pressable
      onPress={() => {
        if (disabled) return;
        Haptics.selectionAsync().catch(() => {});
        onPress?.();
      }}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityHint={accessibilityHint}
      testID={testID}
      style={({ pressed }) => [styles.button, size === 'sm' && styles.buttonSm, { backgroundColor: bg }, disabled && styles.disabled, pressed && !disabled && styles.pressed, style]}>
      {icon ? <Icon name={icon} size={18} color={fg} weight="semibold" /> : null}
      <Text maxFontSizeMultiplier={1.5} style={[styles.buttonText, size === 'sm' && styles.buttonTextSm, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

/** Back-compat: a standalone navigation row is just a one-cell Group. */
export function LinkRow({ icon, iconColor, title, subtitle, onPress, right, style, testID }: { icon?: IconName; iconColor?: string; iconTone?: string; title: string; subtitle?: ReactNode; onPress: () => void; right?: ReactNode; tone?: string; style?: StyleProp<ViewStyle>; testID?: string }) {
  return (
    <Group style={style}>
      <Cell icon={icon} iconColor={iconColor} title={title} subtitle={subtitle} onPress={onPress} accessory={right ? 'none' : 'chevron'} trailing={right} last testID={testID} />
    </Group>
  );
}

/** Reminders-style check control: hollow circle → filled green circle with a check. */
export function Checkbox({ checked, onChange, label, disabled, size = 26 }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; size?: number }) {
  return (
    <Pressable
      onPress={() => {
        if (disabled) return;
        Haptics.selectionAsync().catch(() => {});
        onChange(!checked);
      }}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !!disabled }}
      accessibilityLabel={label}
      hitSlop={10}
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={checked ? 'checkCircle' : 'circle'} size={size} color={checked ? colors.green : colors.ink4} weight={checked ? 'regular' : 'light'} />
    </Pressable>
  );
}

export function Stepper({ label, value, min, max, onChange, hint, icon, last }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; hint?: string; icon?: IconName; last?: boolean }) {
  const dec = () => onChange(Math.max(min, value - 1));
  const inc = () => onChange(Math.min(max, value + 1));
  return (
    <Cell
      icon={icon}
      title={label}
      subtitle={hint}
      last={last}
      trailing={
        <View style={styles.stepper} accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ now: value, min, max, text: String(value) }}>
          <Pressable onPress={dec} accessibilityLabel={t('common.decrease', { label })} accessibilityRole="button" disabled={value <= min} style={({ pressed }) => [styles.stepBtn, value <= min && styles.disabled, pressed && styles.pressed]}>
            <Text maxFontSizeMultiplier={1.3} style={styles.stepBtnText}>−</Text>
          </Pressable>
          <Text maxFontSizeMultiplier={1.3} style={[styles.stepValue, tabular]}>{value}</Text>
          <Pressable onPress={inc} accessibilityLabel={t('common.increase', { label })} accessibilityRole="button" disabled={value >= max} style={({ pressed }) => [styles.stepBtn, value >= max && styles.disabled, pressed && styles.pressed]}>
            <Text maxFontSizeMultiplier={1.3} style={styles.stepBtnText}>+</Text>
          </Pressable>
        </View>
      }
    />
  );
}

export function Toggle({ label, value, onChange, hint, icon, last }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string; icon?: IconName; last?: boolean }) {
  return (
    <Cell
      icon={icon}
      title={label}
      subtitle={hint}
      last={last}
      trailing={
        <Pressable
          onPress={() => {
            Haptics.selectionAsync().catch(() => {});
            onChange(!value);
          }}
          accessibilityRole="switch"
          accessibilityState={{ checked: value }}
          accessibilityLabel={label}
          style={[styles.toggle, value && styles.toggleOn]}>
          <View style={[styles.toggleKnob, value && styles.toggleKnobOn]} />
        </Pressable>
      }
    />
  );
}

export function Segmented<T extends string | number>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label?: string }) {
  return (
    <View style={styles.segmented} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={String(o.value)} onPress={() => onChange(o.value)} accessibilityRole="radio" accessibilityState={{ selected: on, checked: on }} style={[styles.segment, on && styles.segmentOn]}>
            <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={[styles.segmentText, options.length >= 4 && styles.segmentTextSmall, on && styles.segmentTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}


/** Single-line text field inside a group (iOS Settings style). */
export function Field({ label, value, onChangeText, placeholder, last, icon, autoFocus, onSubmitEditing, returnKeyType, maxLength, testID }: { label?: string; value: string; onChangeText: (v: string) => void; placeholder?: string; last?: boolean; icon?: IconName; autoFocus?: boolean; onSubmitEditing?: () => void; returnKeyType?: TextInputProps['returnKeyType']; maxLength?: number; testID?: string }) {
  return (
    <View style={styles.cell}>
      {icon ? <Icon name={icon} size={22} color={colors.tint} style={styles.cellIcon} /> : null}
      <View style={[styles.cellBody, !last && styles.cellSeparator]}>
        {label ? <Text style={[type.body, { flexBasis: '34%' }]}>{label}</Text> : null}
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.ink4}
          autoFocus={autoFocus}
          onSubmitEditing={onSubmitEditing}
          returnKeyType={returnKeyType}
          maxLength={maxLength}
          testID={testID}
          accessibilityLabel={label ?? placeholder}
          style={[type.body, { flex: 1, paddingVertical: 0, minHeight: 22 }]}
        />
      </View>
    </View>
  );
}

/** Key / value row for provenance blocks. */
export function KeyValue({ k, v, last }: { k: string; v: string; last?: boolean; mono?: boolean }) {
  return (
    <View style={[styles.kv, !last && styles.cellSeparator]}>
      <Text style={[type.subheadline, { flexBasis: '40%' }]}>{k}</Text>
      <Text style={[type.subheadline, { flex: 1, color: colors.ink, textAlign: 'right' }, tabular]} selectable>
        {v}
      </Text>
    </View>
  );
}

export const pressStyle: PressableProps['style'] = ({ pressed }) => (pressed ? styles.pressed : null);

const styles = StyleSheet.create({
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', paddingHorizontal: CELL_PAD, paddingTop: 22, paddingBottom: 7 },
  sectionFooter: { paddingHorizontal: CELL_PAD, paddingTop: 7, paddingBottom: 4 },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, paddingHorizontal: 0, marginTop: 24, marginBottom: 10 },
  group: { borderRadius: radius.group, overflow: 'hidden', marginBottom: 10, backgroundColor: colors.surface },
  groupPadded: { paddingHorizontal: CELL_PAD, paddingVertical: 14 },
  cell: { flexDirection: 'row', alignItems: 'center', paddingLeft: CELL_PAD, minHeight: MIN_TAP },
  cellIcon: { marginRight: 14 },
  cellBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingRight: CELL_PAD, minHeight: MIN_TAP },
  cellSeparator: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  cellPressed: { backgroundColor: colors.fill },
  cellValue: { ...type.body, color: colors.ink2 },
  progress: { borderRadius: 2, backgroundColor: colors.fill, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 2 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  hrow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  calloutRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  button: { minHeight: 50, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 18, paddingVertical: 12 },
  buttonSm: { minHeight: 36, paddingVertical: 6, paddingHorizontal: 14, borderRadius: 10 },
  buttonText: { ...type.headline },
  buttonTextSm: { ...type.control, fontWeight: type.headline.fontWeight },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.6 },
  stepper: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.fill, borderRadius: radius.control, padding: 2 },
  stepBtn: { width: 40, height: 32, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  stepBtnText: { ...type.title2, fontWeight: type.control.fontWeight },
  stepValue: { ...type.headline, minWidth: 28, textAlign: 'center' },
  toggle: { width: 51, height: 31, borderRadius: 16, backgroundColor: 'rgba(120,120,128,0.32)', padding: 2, justifyContent: 'center' },
  toggleOn: { backgroundColor: colors.green },
  toggleKnob: { width: 27, height: 27, borderRadius: 14, backgroundColor: colors.white },
  toggleKnobOn: { alignSelf: 'flex-end' },
  segmented: { flexDirection: 'row', backgroundColor: colors.fill, borderRadius: 9, padding: 2 },
  segment: { flex: 1, minHeight: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 7, paddingVertical: 5, paddingHorizontal: 4 },
  segmentOn: { backgroundColor: colors.surface },
  segmentText: { ...type.control, textAlign: 'center' },
  segmentTextSmall: { ...type.controlSmall, textAlign: 'center' },
  segmentTextOn: { fontWeight: type.headline.fontWeight },
  kv: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start', paddingVertical: 10, paddingRight: CELL_PAD },
});

export { fonts };
