/**
 * The intake flow (spec 4.1, screens S-04 → S-07) as one nested stack presented full-screen over the tabs:
 * /new (capture) → /new/analysis → /new/form → /new/submitted. Native headers hidden; screens draw their own.
 */
import { Stack } from 'expo-router';

import { colors } from '@/ui/theme';

export default function NewReportLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="analysis" />
      <Stack.Screen name="form" />
      <Stack.Screen name="submitted" />
    </Stack>
  );
}
