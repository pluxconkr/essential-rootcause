/**
 * Report tab placeholder. The tab bar intercepts the tap and opens /report/capture as a modal (see (tabs)/_layout),
 * so this screen is only reached by deep link; it simply offers the same button.
 */
import { useRouter } from 'expo-router';

import { t } from '@/i18n';
import { Screen } from '@/ui/Screen';
import { Button, Callout } from '@/ui/primitives';

export default function ReportTabScreen() {
  const router = useRouter();
  return (
    <Screen largeTitle={t('tab.report')} testID="report-tab">
      <Callout icon="camera" tone="tint" title="Report a hazard in under a minute">
        Three steps: photograph it, check what we could tell from the photo, answer two questions a camera cannot.
      </Callout>
      <Button title={t('map.reportHere')} icon="camera" onPress={() => router.push('/new')} style={{ marginTop: 12 }} />
    </Screen>
  );
}
