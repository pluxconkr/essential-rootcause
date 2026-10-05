/**
 * Five fixed tabs (spec R1–R8, R13): Home · Map · Report · Alerts · Me. The centre Report tab never shows a
 * screen of its own — tapping it opens the capture flow as a full-screen modal, so a report is one tap away
 * (spec 4.1 "open app → tap camera"). Labels do not scale, like UIKit.
 */
import { Tabs } from 'expo-router/js-tabs';
import { useRouter } from 'expo-router';
import { Platform, StyleSheet, View } from 'react-native';

import { t } from '@/i18n';
import { useAppState } from '@/store/appStore';
import { Icon, type IconName } from '@/ui/icons';
import { colors, type } from '@/ui/theme';

function TabIcon({ name, color }: { name: IconName; color: string }) {
  return <Icon name={name} size={24} color={color} weight="medium" />;
}

export default function TabLayout() {
  const router = useRouter();
  const unread = useAppState((s) => s.alerts.some((a) => !a.read));
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.tint,
        tabBarInactiveTintColor: colors.ink2,
        tabBarStyle: styles.bar,
        tabBarLabelStyle: styles.label,
        tabBarAllowFontScaling: false,
        lazy: false,
        sceneStyle: { backgroundColor: colors.bg },
      }}>
      <Tabs.Screen name="index" options={{ title: t('tab.home'), tabBarIcon: ({ color, focused }) => <TabIcon name={focused ? 'home' : 'homeOutline'} color={String(color)} /> }} />
      <Tabs.Screen name="map" options={{ title: t('tab.map'), tabBarIcon: ({ color, focused }) => <TabIcon name={focused ? 'map' : 'mapOutline'} color={String(color)} /> }} />
      <Tabs.Screen
        name="report"
        options={{ title: t('tab.report'), tabBarIcon: ({ color, focused }) => <TabIcon name={focused ? 'camera' : 'cameraOutline'} color={String(color)} /> }}
        listeners={{
          tabPress: (e) => {
            e.preventDefault();
            router.push('/report/capture');
          },
        }}
      />
      <Tabs.Screen
        name="alerts"
        options={{
          title: t('tab.alerts'),
          tabBarIcon: ({ color, focused }) => (
            <View>
              <TabIcon name={focused ? 'bell' : 'bellOutline'} color={String(color)} />
              {unread ? <View style={styles.dot} /> : null}
            </View>
          ),
        }}
      />
      <Tabs.Screen name="me" options={{ title: t('tab.me'), tabBarIcon: ({ color, focused }) => <TabIcon name={focused ? 'person' : 'personOutline'} color={String(color)} /> }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: 'rgba(249,249,249,0.94)', borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth, height: Platform.OS === 'ios' ? 84 : 64, paddingTop: 6 },
  label: { ...type.tabLabel, marginTop: 1 },
  dot: { position: 'absolute', top: -1, right: -4, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red, borderWidth: 1.5, borderColor: '#F9F9F9' },
});
