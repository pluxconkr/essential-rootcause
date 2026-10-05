/**
 * S-13 Privacy & photo handling (spec §13). Plain statements of what leaves the phone, what the city sees,
 * how long things are kept, and what "delete my data" does. Legal review pending (docs/privacy.md is the draft).
 */
import { t } from '@/i18n';
import { Screen } from '@/ui/Screen';
import { Cell, Group, SectionFooter, SectionHeader } from '@/ui/primitives';
import { colors } from '@/ui/theme';

export default function PrivacyScreen() {
  return (
    <Screen title={t('me.privacy')} largeTitle={t('me.privacy')} testID="privacy">
      <SectionHeader>Photos</SectionHeader>
      <Group>
        <Cell icon="camera" iconColor={colors.tint} title="You see exactly what is uploaded" subtitle="Photos are resized on your phone and location metadata is removed before they leave it." />
        <Cell icon="eyeSlash" iconColor={colors.tint} title="Reviewed before they are public" subtitle="A city inspector looks at each photo before other residents can see it. Faces and plates are not blurred yet — keep them out of frame." last />
      </Group>
      <SectionHeader>Location</SectionHeader>
      <Group>
        <Cell icon="location" iconColor={colors.tint} title="The hazard's location is shared" subtitle="Crews need the exact spot. On the public map, reports linked to a named reporter are shown about 50 m off." />
        <Cell icon="lock" iconColor={colors.tint} title="Your home area is not" subtitle="It stays on this phone unless you save it as a watch area, and watch areas are never shown to anyone." last />
      </Group>
      <SectionHeader>Identity</SectionHeader>
      <Group>
        <Cell icon="person" iconColor={colors.tint} title="Named, initials or anonymous — per report" subtitle="An anonymous report is not linked to your account anywhere on the server, so it cannot receive status updates." />
        <Cell icon="shield" iconColor={colors.tint} title="Not shared with enforcement agencies" subtitle="No immigration status is collected. Reports are about public right-of-way hazards, not people." last />
      </Group>
      <SectionHeader>Keeping and deleting</SectionHeader>
      <Group>
        <Cell icon="clock" iconColor={colors.tint} title="Reports and photos are public records" subtitle="They are kept for 7 years and may be released under records law." />
        <Cell icon="trash" iconColor={colors.tint} title="Delete my data removes you, not the hazard" subtitle="Your account, phone number, watch areas and the link between you and your reports are deleted. The reports stay, as anonymous." last />
      </Group>
      <SectionFooter>Draft wording, pending legal review. Questions: see the contact address in the app store listing.</SectionFooter>
    </Screen>
  );
}
