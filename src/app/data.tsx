/**
 * S-12 Offline data. What is saved on this phone and when, drafts waiting to send, the simulate-offline switch,
 * the demo scenario picker, the low-storage notice, and the reset. Mirrors the siblings' Downloads / Offline data screen.
 */
import { useRouter } from 'expo-router';
import { Alert, Platform } from 'react-native';

import { relativeAgo } from '@/domain/time';
import type { DemoScenario } from '@/domain/types';
import { t } from '@/i18n';
import { signOut } from '@/services/auth';
import { applyDemoScenario } from '@/services/demo';
import { removeMapPack } from '@/services/mapOffline';
import { refreshAll } from '@/services/refresh';
import { actions, useAppState } from '@/store/appStore';
import { usePendingDrafts, useRealNow } from '@/store/derived';
import { MapPackCell } from '@/ui/MapPackCell';
import { Screen } from '@/ui/Screen';
import { Button, Callout, Group, KeyValue, SectionFooter, SectionHeader, Segmented, Toggle } from '@/ui/primitives';

type Pick = DemoScenario | 'off';

export default function DataScreen() {
  const router = useRouter();
  const meta = useAppState((s) => s.cacheMeta);
  const feedCount = useAppState((s) => s.feed.length);
  const settings = useAppState((s) => s.settings);
  const notice = useAppState((s) => s.storageNotice);
  const refreshing = useAppState((s) => s.refreshing);
  const drafts = usePendingDrafts();
  const realNow = useRealNow();

  function confirmReset() {
    const go = async () => {
      void removeMapPack();
      await signOut(); // the Supabase tokens live outside the store's keys; without this the account would come back on the next refresh
      actions.resetAll();
      router.replace('/onboarding');
    };
    if (Platform.OS === 'web') {
      if (globalThis.confirm?.('Delete saved reports, drafts and settings on this phone?')) go();
      return;
    }
    Alert.alert(t('data.reset'), 'Saved reports, drafts (and their photos) and settings on this phone will be deleted.', [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('data.reset'), style: 'destructive', onPress: go },
    ]);
  }

  return (
    <Screen title={t('data.title')} largeTitle={t('data.title')} testID="data">
      {notice ? (
        <Callout icon="alert" tone="amber" title={t('data.storage.title')}>
          {t('data.storage.body', { items: notice.dropped.join(', ') })}
        </Callout>
      ) : null}
      <SectionHeader>{t('data.cache')}</SectionHeader>
      <Group>
        <KeyValue k="Reports saved" v={String(feedCount)} />
        <KeyValue k="Last checked" v={meta.feed ? relativeAgo(meta.feed.fetchedAt, realNow) : t('common.notConfirmed')} />
        <KeyValue k={t('data.drafts')} v={String(drafts.length)} last />
      </Group>
      <Button title={refreshing ? 'Refreshing…' : 'Check for new reports'} variant="tonal" icon="refresh" onPress={() => void refreshAll()} disabled={refreshing} />
      <MapPackCell />
      <SectionHeader>Testing</SectionHeader>
      <Group>
        <Toggle label={t('data.simulateOffline')} value={settings.simulateOffline} onChange={(v) => actions.patchSettings({ simulateOffline: v })} icon="offline" last />
      </Group>
      <SectionHeader>{t('data.demo')}</SectionHeader>
      <Group padded>
        <Segmented<Pick>
          options={[
            { value: 'off', label: t('data.demo.off') },
            { value: 'calm', label: t('data.demo.calm') },
            { value: 'storm', label: t('data.demo.storm') },
            { value: 'verify', label: t('data.demo.verify') },
          ]}
          value={settings.demoScenario ?? 'off'}
          onChange={(v) => applyDemoScenario(v === 'off' ? null : v)}
        />
      </Group>
      <SectionFooter>Demo data is generated on this phone and labelled everywhere it appears. It never mixes with live reports.</SectionFooter>
      <Button title={t('data.reset')} variant="red" icon="trash" onPress={confirmReset} style={{ marginTop: 8 }} />
    </Screen>
  );
}
