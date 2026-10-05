/**
 * Root layout. Synchronous hydration before the first frame; onboarding gated with Stack.Protected; every native
 * header hidden (screens draw their own). Boot wiring: demo scenario re-materialised, network watch → refresh,
 * foreground → refresh. No network before the first frame.
 */
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { AppState, Platform, useWindowDimensions } from 'react-native';

import { restoreDemoScenario } from '@/services/demo';
import { startNetworkWatch } from '@/services/network';
import { refreshIfStale } from '@/services/refresh';
import { hydrate, useAppState } from '@/store/appStore';
import { colors } from '@/ui/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

// Synchronous hydration: the first frame already shows saved reports, drafts and settings.
hydrate();

export const unstable_settings = {
  anchor: '(tabs)',
};

const theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: colors.bg, card: colors.surface, primary: colors.brand, text: colors.ink, border: colors.line },
};

export default function RootLayout() {
  const onboarded = useAppState((s) => s.onboarded);
  // Text that is already mounted keeps its old measurements when the user changes text size; remounting fixes it.
  const { fontScale } = useWindowDimensions();
  const booted = useRef(false);

  useEffect(() => {
    SplashScreen.hide();
    if (booted.current) return;
    booted.current = true;
    // Demo data is never persisted; its clock offset is relative to today, so rebuild it before any refresh runs.
    restoreDemoScenario();
    const stopNet = startNetworkWatch((info) => {
      if (info.online) void refreshIfStale();
    });
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') void refreshIfStale();
    });
    return () => {
      stopNet();
      sub.remove();
    };
  }, []);

  return (
    <ThemeProvider value={theme}>
      <StatusBar style={Platform.OS === 'ios' ? 'dark' : 'auto'} />
      <Stack key={`fs-${fontScale}`} screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Protected guard={!onboarded}>
          <Stack.Screen name="onboarding" />
        </Stack.Protected>
        <Stack.Protected guard={onboarded}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="report/[id]" />
          <Stack.Screen name="new" options={{ presentation: 'fullScreenModal' }} />
          <Stack.Screen name="sign-in" options={{ presentation: 'modal' }} />
          <Stack.Screen name="settings" />
          <Stack.Screen name="watch-areas" />
          <Stack.Screen name="data" />
          <Stack.Screen name="why/score/[id]" options={{ presentation: 'modal' }} />
        </Stack.Protected>
        {/* Public pages: reachable before onboarding and on the web (SMS program language is a 10DLC prerequisite). */}
        <Stack.Screen name="privacy" />
        <Stack.Screen name="terms" />
        <Stack.Screen name="auth/callback" />
        <Stack.Screen name="r/[id]" />
      </Stack>
    </ThemeProvider>
  );
}
