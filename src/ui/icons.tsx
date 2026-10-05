/**
 * Icons: SF Symbols on iOS (expo-symbols), Ionicons elsewhere. Always inline, never on a
 * background shape — the glyph and its tint carry the meaning.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { SymbolView, type SymbolWeight } from 'expo-symbols';
import type { ComponentProps } from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';

import type { Category, ReportStatus } from '@/domain/types';

type IonName = ComponentProps<typeof Ionicons>['name'];

const ICONS = {
  home: { sf: 'house.fill', ion: 'home' },
  homeOutline: { sf: 'house', ion: 'home-outline' },
  map: { sf: 'map.fill', ion: 'map' },
  mapOutline: { sf: 'map', ion: 'map-outline' },
  camera: { sf: 'camera.fill', ion: 'camera' },
  cameraOutline: { sf: 'camera', ion: 'camera-outline' },
  bell: { sf: 'bell.fill', ion: 'notifications' },
  bellOutline: { sf: 'bell', ion: 'notifications-outline' },
  person: { sf: 'person.fill', ion: 'person' },
  personOutline: { sf: 'person', ion: 'person-outline' },
  vegetation: { sf: 'leaf.fill', ion: 'leaf-outline' },
  roadway: { sf: 'car.fill', ion: 'car-outline' },
  sidewalk: { sf: 'figure.walk', ion: 'walk-outline' },
  drainage: { sf: 'drop.fill', ion: 'water-outline' },
  lighting: { sf: 'lightbulb.fill', ion: 'bulb-outline' },
  tree: { sf: 'tree.fill', ion: 'leaf-outline' },
  vote: { sf: 'arrowtriangle.up.fill', ion: 'caret-up' },
  voteOutline: { sf: 'arrowtriangle.up', ion: 'caret-up-outline' },
  rain: { sf: 'cloud.rain.fill', ion: 'rainy-outline' },
  wind: { sf: 'wind', ion: 'cloudy-outline' },
  freeze: { sf: 'snowflake', ion: 'snow-outline' },
  storm: { sf: 'cloud.bolt.rain.fill', ion: 'thunderstorm-outline' },
  received: { sf: 'tray.and.arrow.down.fill', ion: 'download-outline' },
  inspector: { sf: 'person.badge.shield.checkmark.fill', ion: 'shield-checkmark-outline' },
  assessed: { sf: 'doc.text.magnifyingglass', ion: 'search-outline' },
  mitigated: { sf: 'cone.fill', ion: 'warning-outline' },
  scheduled: { sf: 'calendar', ion: 'calendar-outline' },
  completed: { sf: 'hammer.fill', ion: 'hammer-outline' },
  verified: { sf: 'checkmark.seal.fill', ion: 'checkmark-done-circle-outline' },
  rejected: { sf: 'xmark.octagon.fill', ion: 'close-circle-outline' },
  check: { sf: 'checkmark', ion: 'checkmark' },
  checkCircle: { sf: 'checkmark.circle.fill', ion: 'checkmark-circle' },
  circle: { sf: 'circle', ion: 'ellipse-outline' },
  chevron: { sf: 'chevron.right', ion: 'chevron-forward' },
  back: { sf: 'chevron.left', ion: 'chevron-back' },
  close: { sf: 'xmark', ion: 'close' },
  info: { sf: 'info.circle', ion: 'information-circle-outline' },
  offline: { sf: 'wifi.slash', ion: 'cloud-offline-outline' },
  download: { sf: 'arrow.down.circle', ion: 'cloud-download-outline' },
  refresh: { sf: 'arrow.clockwise', ion: 'refresh' },
  eye: { sf: 'eye.fill', ion: 'eye-outline' },
  eyeSlash: { sf: 'eye.slash.fill', ion: 'eye-off-outline' },
  shield: { sf: 'checkmark.shield.fill', ion: 'shield-checkmark-outline' },
  flask: { sf: 'function', ion: 'flask-outline' },
  trash: { sf: 'trash', ion: 'trash-outline' },
  settings: { sf: 'slider.horizontal.3', ion: 'options-outline' },
  chart: { sf: 'chart.bar.fill', ion: 'bar-chart-outline' },
  plus: { sf: 'plus', ion: 'add' },
  minus: { sf: 'minus', ion: 'remove' },
  lock: { sf: 'lock.fill', ion: 'lock-closed-outline' },
  question: { sf: 'questionmark.circle', ion: 'help-circle-outline' },
  phone: { sf: 'phone.fill', ion: 'call' },
  link: { sf: 'link', ion: 'link-outline' },
  share: { sf: 'square.and.arrow.up', ion: 'share-outline' },
  flag: { sf: 'flag.fill', ion: 'flag-outline' },
  alert: { sf: 'exclamationmark.triangle.fill', ion: 'warning' },
  emergency: { sf: 'light.beacon.max.fill', ion: 'alert-circle' },
  location: { sf: 'location.fill', ion: 'navigate' },
  locationOff: { sf: 'location.slash', ion: 'navigate-outline' },
  pin: { sf: 'mappin', ion: 'location-outline' },
  sparkle: { sf: 'sparkles', ion: 'sparkles-outline' },
  document: { sf: 'doc.text', ion: 'document-text-outline' },
  photo: { sf: 'photo.on.rectangle', ion: 'images-outline' },
  comment: { sf: 'bubble.left.fill', ion: 'chatbubble-outline' },
  school: { sf: 'graduationcap.fill', ion: 'school-outline' },
  accessible: { sf: 'figure.roll', ion: 'accessibility-outline' },
  clock: { sf: 'clock', ion: 'time-outline' },
  signIn: { sf: 'person.crop.circle.badge.checkmark', ion: 'log-in-outline' },
  apple: { sf: 'apple.logo', ion: 'logo-apple' },
  google: { sf: 'g.circle', ion: 'logo-google' },
  mail: { sf: 'envelope.fill', ion: 'mail-outline' },
} as const satisfies Record<string, { sf: string; ion: IonName }>;

export type IconName = keyof typeof ICONS;

/**
 * Decorative by default: the adjacent text carries the meaning, so VoiceOver must not read symbol
 * names. Controls whose only content is an icon label themselves.
 */
export function Icon({ name, size = 20, color = '#0B0F19', weight = 'medium', style }: { name: IconName; size?: number; color?: string; weight?: SymbolWeight; style?: StyleProp<ViewStyle> }) {
  const def = ICONS[name];
  const fallback = <Ionicons name={def.ion} size={size} color={color} />;
  const glyph = Platform.OS === 'ios' ? <SymbolView name={def.sf as never} size={size} tintColor={color} weight={weight} resizeMode="scaleAspectFit" style={{ width: size, height: size }} fallback={fallback} /> : fallback;
  return (
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}>
      {glyph}
    </View>
  );
}

/** One glyph per hazard category, used wherever a report is listed. */
export function categoryIcon(category: Category): IconName {
  return category;
}

/** One glyph per status step on the timeline. */
export function statusIcon(status: ReportStatus): IconName {
  switch (status) {
    case 'new':
      return 'received';
    case 'triaged':
      return 'inspector';
    case 'assessed':
      return 'assessed';
    case 'mitigated':
      return 'mitigated';
    case 'scheduled':
      return 'scheduled';
    case 'completed':
      return 'completed';
    case 'verified':
      return 'verified';
    default:
      return 'rejected';
  }
}
