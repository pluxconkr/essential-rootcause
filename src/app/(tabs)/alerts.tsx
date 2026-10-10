/**
 * S-03 Alerts inbox (spec R8). Predictive alerts fetched for the account (each with its briefing, S-09) beside the
 * status alerts mirrored from pushes; chips All · Weather · Status; the labelled storm advisory while the demo runs;
 * the link to the alert rules (S-11). Every alert names a place and an action. Empty state is a real cell, never a
 * blank screen. Renders from local data; the inbox refreshes with everything else (services/refresh).
 */
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { demoStormAlertItem } from '@/domain/alerts';
import { formatDateTime } from '@/domain/time';
import type { AlertItem } from '@/domain/types';
import { t } from '@/i18n';
import { markAlertRead } from '@/services/alerts';
import { demoNote } from '@/services/demo';
import { useAppState } from '@/store/appStore';
import { useNow, useReports } from '@/store/derived';
import { Screen } from '@/ui/Screen';
import type { IconName } from '@/ui/icons';
import { Cell, Group, SectionFooter, SectionHeader, Segmented } from '@/ui/primitives';
import { colors } from '@/ui/theme';

type Chip = 'all' | 'weather' | 'status';

/** The glyph says what kind of weather (or status) this is; the tint says how urgent. */
export function alertIcon(a: AlertItem): { icon: IconName; color: string } {
  if (a.kind === 'status') return { icon: 'received', color: colors.tint };
  if (a.kind === 'emergency') return { icon: 'emergency', color: colors.red };
  const trigger = a.briefing?.trigger;
  const icon: IconName = trigger === 'rain' ? 'rain' : trigger === 'wind' ? 'wind' : trigger === 'freeze' ? 'freeze' : 'storm';
  return { icon, color: a.kind === 'warning' ? colors.amber : colors.blue };
}

export default function AlertsScreen() {
  const router = useRouter();
  const alerts = useAppState((s) => s.alerts);
  const scenario = useAppState((s) => s.settings.demoScenario);
  const reports = useReports();
  const now = useNow();
  const [chip, setChip] = useState<Chip>('all');
  const items = useMemo<AlertItem[]>(() => (scenario === 'storm' ? [demoStormAlertItem(reports, now), ...alerts] : alerts), [alerts, scenario, reports, now]);
  const shown = useMemo(() => items.filter((a) => chip === 'all' || (chip === 'status' ? a.kind === 'status' : a.kind !== 'status')), [items, chip]);

  function open(a: AlertItem) {
    void markAlertRead(a.id);
    if (a.briefing) router.push({ pathname: '/alert/[id]', params: { id: a.id } });
    else if (a.reportId) router.push({ pathname: '/report/[id]', params: { id: a.reportId } });
  }

  const empty = chip === 'weather' ? { title: t('alerts.empty.weather.title'), body: t('alerts.empty.weather.body') } : chip === 'status' ? { title: t('alerts.empty.status.title'), body: t('alerts.empty.status.body') } : { title: t('alerts.empty.title'), body: t('alerts.empty.body') };

  return (
    <Screen largeTitle={t('alerts.title')} note={demoNote()} testID="alerts">
      <View style={{ marginTop: 8, marginBottom: 4 }}>
        <Segmented<Chip> options={[{ value: 'all', label: t('alerts.filter.all') }, { value: 'weather', label: t('alerts.filter.weather') }, { value: 'status', label: t('alerts.filter.status') }]} value={chip} onChange={setChip} label={t('alerts.title')} />
      </View>
      <SectionHeader>Inbox</SectionHeader>
      <Group>
        {shown.length === 0 ? (
          <Cell icon="bellOutline" iconColor={colors.ink2} title={empty.title} subtitle={empty.body} last />
        ) : (
          shown.map((a, i) => {
            const { icon, color } = alertIcon(a);
            const opens = Boolean(a.briefing || a.reportId);
            return (
              <Cell
                key={a.id}
                icon={icon}
                iconColor={color}
                title={`${a.title}${a.isDemo ? ` · ${t('common.demo').toLowerCase()}` : ''}`}
                subtitle={`${a.body}\n${formatDateTime(a.at)}${a.read ? '' : ' · new'}`}
                accessory={opens ? 'chevron' : 'none'}
                onPress={opens ? () => open(a) : undefined}
                last={i === shown.length - 1}
                testID={`alert-${a.id}`}
              />
            );
          })
        )}
      </Group>
      <Group>
        <Cell icon="settings" iconColor={colors.tint} title={t('alerts.rules')} subtitle={t('alerts.rulesHint')} accessory="chevron" onPress={() => router.push('/settings')} testID="alerts-rules" last />
      </Group>
      <SectionFooter>Emergency alerts always break through quiet hours and the weekly limit.</SectionFooter>
    </Screen>
  );
}
