/**
 * S-03 Alerts inbox (spec R8). Status alerts on own and followed reports; scenario advisories arrive in M4.
 * Every alert names a place and an action. Empty state is a real cell, never a blank screen.
 */
import { useRouter } from 'expo-router';
import { useMemo } from 'react';

import { DEMO_SCENARIOS } from '@/domain/demo';
import { formatDateTime, nowMs } from '@/domain/time';
import type { AlertItem } from '@/domain/types';
import { t } from '@/i18n';
import { demoNote } from '@/services/demo';
import { actions, useAppState } from '@/store/appStore';
import { Screen } from '@/ui/Screen';
import { Cell, Group, SectionFooter, SectionHeader } from '@/ui/primitives';
import { colors } from '@/ui/theme';

export default function AlertsScreen() {
  const router = useRouter();
  const alerts = useAppState((s) => s.alerts);
  const scenario = useAppState((s) => s.settings.demoScenario);
  const items = useMemo<AlertItem[]>(() => {
    if (scenario !== 'storm') return alerts;
    const storm = DEMO_SCENARIOS.storm;
    return [{ id: 'demo-storm', kind: 'warning', title: storm.alertTitle, body: storm.alertBody, reportId: null, alertId: null, at: new Date(nowMs()).toISOString(), read: true, isDemo: true }, ...alerts];
  }, [alerts, scenario]);
  return (
    <Screen largeTitle={t('alerts.title')} note={demoNote()} testID="alerts">
      <SectionHeader>Inbox</SectionHeader>
      <Group>
        {items.length === 0 ? (
          <Cell icon="bellOutline" iconColor={colors.ink2} title={t('alerts.empty.title')} subtitle={t('alerts.empty.body')} last />
        ) : (
          items.map((a, i) => (
            <Cell
              key={a.id}
              icon={a.kind === 'status' ? 'received' : a.kind === 'emergency' ? 'emergency' : 'storm'}
              iconColor={a.kind === 'emergency' ? colors.red : a.kind === 'status' ? colors.tint : colors.blue}
              title={`${a.title}${a.isDemo ? ` · ${t('common.demo').toLowerCase()}` : ''}`}
              subtitle={`${a.body}\n${formatDateTime(a.at)}`}
              accessory={a.reportId ? 'chevron' : 'none'}
              onPress={a.reportId ? () => {
                actions.markAlertRead(a.id);
                router.push({ pathname: '/report/[id]', params: { id: a.reportId as string } });
              } : undefined}
              last={i === items.length - 1}
            />
          ))
        )}
      </Group>
      <SectionFooter>Quiet hours and the two-per-week limit on weather advisories are set in Me → Alert rules. Emergency alerts always break through.</SectionFooter>
    </Screen>
  );
}
