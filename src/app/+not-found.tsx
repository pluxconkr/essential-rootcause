/** Unknown route (bad deep link): say so and offer the way home. */
import { useRouter } from 'expo-router';

import { Screen } from '@/ui/Screen';
import { Button, Callout } from '@/ui/primitives';

export default function NotFoundScreen() {
  const router = useRouter();
  return (
    <Screen largeTitle="Not found" testID="not-found">
      <Callout icon="question" title="That link does not point to anything in RootCause.">Open the app from the Home tab instead.</Callout>
      <Button title="Back to Home" onPress={() => router.replace('/')} style={{ marginTop: 12 }} />
    </Screen>
  );
}
