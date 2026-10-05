/**
 * S-04 Capture (spec R3) — route /new. M0 scaffold of the three-step intake. The camera, photo processing, vision assist and
 * the form land in M1 (plan §15). Until then the screen states the steps and what each will do, and lets the
 * resident go back. No fake shutter: a control that does nothing would be a lie.
 */
import { useRouter } from 'expo-router';

import { t } from '@/i18n';
import { Screen, goBackOr } from '@/ui/Screen';
import { Button, Cell, Group, SectionFooter, SectionHeader } from '@/ui/primitives';
import { colors } from '@/ui/theme';

export default function CaptureScreen() {
  const router = useRouter();
  return (
    <Screen title="Report a hazard" largeTitle="Report a hazard" subtitle="Step 1 of 3 · capture" testID="capture">
      <SectionHeader>What happens</SectionHeader>
      <Group>
        <Cell icon="camera" iconColor={colors.tint} title="1 · Photograph the hazard" subtitle="Include the ground and something for scale. Keep people and licence plates out of frame." />
        <Cell icon="sparkle" iconColor={colors.tint} title="2 · Check what we could tell" subtitle="Category and sub-type proposals, and any existing report within 25 m you can add to instead." />
        <Cell icon="document" iconColor={colors.tint} title="3 · Answer two questions" subtitle="How dangerous is it right now, and has anyone been hurt. Then you see the score and the queue position." last />
      </Group>
      <SectionFooter>Reports are saved on this phone first and sent when you have a signal. Capture ships in the next build; this screen is the contract for it.</SectionFooter>
      <Button title={t('common.back')} variant="secondary" onPress={() => goBackOr(router, '/')} />
    </Screen>
  );
}
