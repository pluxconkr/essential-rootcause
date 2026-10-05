/**
 * Terms of use (web `/terms` and in-app). Public and reachable before onboarding: the SMS program language here is a
 * prerequisite for the Twilio 10DLC campaign (plan §23.H). Draft wording pending legal review (docs/terms.md).
 */
import { Screen } from '@/ui/Screen';
import { Body, Group, SectionFooter, SectionHeader } from '@/ui/primitives';

export default function TermsScreen() {
  return (
    <Screen title="Terms of use" largeTitle="Terms of use" testID="terms">
      <SectionHeader>Using RootCause</SectionHeader>
      <Group padded>
        <Body>RootCause is for reporting physical hazards on public property: sidewalks, roads, drains, street lights and city trees. Reports, photos and comments are public records of the city and may be released under records law. Do not post people, licence plates, or anything about private individuals.</Body>
      </Group>
      <SectionHeader>Accounts and votes</SectionHeader>
      <Group padded>
        <Body>Browsing needs no account. Filing, voting, commenting and following need one, so each person has one vote per report. You may file any report anonymously; anonymous reports are not linked to your account and cannot receive status updates.</Body>
      </Group>
      <SectionHeader>Text messages (SMS program)</SectionHeader>
      <Group padded>
        <Body>By adding and verifying a phone number you agree to receive text messages from RootCause: status updates on your reports, weather advisories for your watch areas (no more than two predictive alerts per week) and emergency notices. Message frequency varies. Message and data rates may apply. Reply STOP to cancel at any time; reply HELP for help. We do not share, sell, or provide your mobile phone number or messaging consent data to third parties or affiliates for marketing or promotional purposes.</Body>
      </Group>
      <SectionHeader>Emergencies</SectionHeader>
      <Group padded>
        <Body>RootCause is not an emergency service. If anyone is in danger right now, call 911. The “Emergency” answer in a report pages the on-call supervisor, but response times are not guaranteed.</Body>
      </Group>
      <SectionFooter>Draft wording, pending legal review. The privacy notice explains what is collected and kept.</SectionFooter>
    </Screen>
  );
}
