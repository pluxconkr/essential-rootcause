/**
 * S-09 Alert briefing (spec R9 "Storm briefing"): why you got this, the forecast facts the rule read, the specific
 * spots — each opens its work order, with the distance from where you are — what the city is doing, and the note that
 * the same list went to DPW. Renders from the inbox item's briefing: nothing is fetched here, and an id this phone
 * does not hold shows an honest not-found cell. The storm demo builds its briefing from the labelled demo reports with
 * the template the server uses (src/domain/alerts.ts). Opening marks the alert read; the receipt is posted best-effort.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { DEMO_STORM_ALERT_ID, demoStormAlertItem } from '@/domain/alerts';
import { distanceM } from '@/domain/geo';
import { formatDateTime, formatTime } from '@/domain/time';
import type { AlertBody, AlertItem } from '@/domain/types';
import { t } from '@/i18n';
import { markAlertRead } from '@/services/alerts';
import { useAppState } from '@/store/appStore';
import { useNow, useReports, useVantage } from '@/store/derived';
import { Screen, goBackOr } from '@/ui/Screen';
import { Icon, categoryIcon, type IconName } from '@/ui/icons';
import { Body, Button, Callout, Cell, Group, KeyValue, SectionFooter, SectionHeader } from '@/ui/primitives';
import { colors, type } from '@/ui/theme';

const TRIGGER_ICON: Record<AlertBody['trigger'], IconName> = { rain: 'rain', wind: 'wind', freeze: 'freeze', manual: 'storm' };

function briefingLabel(trigger: AlertBody['trigger']): string {
  return trigger === 'rain' ? t('alerts.briefing.rain') : trigger === 'wind' ? t('alerts.briefing.wind') : trigger === 'freeze' ? t('alerts.briefing.freeze') : t('alerts.briefing.manual');
}

function formatDistance(m: number): string {
  return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

export default function AlertBriefingScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const alerts = useAppState((s) => s.alerts);
  const scenario = useAppState((s) => s.settings.demoScenario);
  const reports = useReports();
  const from = useVantage();
  const now = useNow();

  const item = useMemo<AlertItem | null>(() => {
    if (!id) return null;
    if (id === DEMO_STORM_ALERT_ID) return scenario === 'storm' ? demoStormAlertItem(reports, now) : null;
    // By inbox id, or by the server's alert id (a push payload deep-links with {alertId}).
    return alerts.find((a) => a.id === id) ?? alerts.find((a) => a.alertId !== null && a.alertId === id) ?? null;
  }, [id, scenario, reports, now, alerts]);
  const itemId = item?.id ?? null;
  const unread = item ? !item.read && !item.isDemo : false;

  useEffect(() => {
    if (itemId && unread) void markAlertRead(itemId);
  }, [itemId, unread]);

  const briefing = item?.briefing ?? null;
  if (!item || !briefing) {
    return (
      <Screen title={t('alerts.title')} fallback="/alerts" testID="alert-briefing">
        <Callout icon="info" title={t('alerts.notFound.title')}>{t('alerts.notFound.body')}</Callout>
        <Button title={t('alerts.back')} variant="secondary" onPress={() => goBackOr(router, '/alerts')} />
      </Screen>
    );
  }

  const f = briefing.forecast;
  const facts: { k: string; v: string }[] = [];
  if (f?.rainMm6h != null) facts.push({ k: t('alerts.rain6h'), v: `${Math.round(f.rainMm6h)} mm` });
  if (f?.popPct != null) facts.push({ k: t('alerts.chance'), v: `${Math.round(f.popPct)}%` });
  if (f?.gustKmh != null) facts.push({ k: t('alerts.gusts'), v: `${Math.round(f.gustKmh)} km/h` });
  if (f?.tempMinC != null) facts.push({ k: t('alerts.low'), v: `${Math.round(f.tempMinC)} °C` });
  if (briefing.validFrom) facts.push({ k: t('alerts.window'), v: `${formatTime(briefing.validFrom)}${briefing.validTo ? ` – ${formatTime(briefing.validTo)}` : ''}` });
  if (f) facts.push({ k: t('alerts.issued'), v: formatDateTime(f.issuedAt) }, { k: t('alerts.source'), v: f.source });

  return (
    <Screen title={briefingLabel(briefing.trigger)} fallback="/alerts" testID="alert-briefing">
      <Group padded>
        <View style={styles.head}>
          <Icon name={TRIGGER_ICON[briefing.trigger]} size={28} color={briefing.kind === 'emergency' ? colors.red : briefing.kind === 'warning' ? colors.amber : colors.blue} />
          <View style={{ flex: 1 }}>
            <Text style={type.footnote}>
              {briefingLabel(briefing.trigger)}
              {f ? ` · issued ${formatTime(f.issuedAt)}` : ''}
              {item.isDemo ? ` · ${t('common.demo').toLowerCase()}` : ''}
            </Text>
            <Text style={[type.title3, { marginTop: 2 }]} accessibilityRole="header" testID="alert-title">
              {briefing.title}
            </Text>
          </View>
        </View>
        <Text style={[type.body, { marginTop: 10 }]}>{briefing.body}</Text>
      </Group>

      <SectionHeader>{t('alerts.why')}</SectionHeader>
      <Group padded>
        <Body>{briefing.why}</Body>
      </Group>

      {facts.length ? (
        <>
          <SectionHeader>{t('alerts.forecast')}</SectionHeader>
          <Group>
            {facts.map((row, i) => (
              <KeyValue key={row.k} k={row.k} v={row.v} last={i === facts.length - 1} />
            ))}
          </Group>
        </>
      ) : null}

      <SectionHeader right={String(briefing.spots.length)}>{t('alerts.spots')}</SectionHeader>
      <Group>
        {briefing.spots.length === 0 ? (
          <Cell icon="pin" iconColor={colors.ink2} title={t('alerts.noSpots')} last />
        ) : (
          briefing.spots.map((s, i) => {
            const report = reports.find((r) => r.id === s.reportId) ?? null;
            const dist = report ? distanceM(from, report) : s.distanceM;
            return (
              <Cell
                key={s.reportId}
                icon={report ? categoryIcon(report.category) : 'pin'}
                iconColor={colors.ink2}
                title={s.title}
                subtitle={`${dist != null ? `${formatDistance(dist)} · ` : ''}${s.line}`}
                accessory="chevron"
                onPress={() => router.push({ pathname: '/report/[id]', params: { id: s.reportId } })}
                last={i === briefing.spots.length - 1}
                testID={`alert-spot-${s.reportId}`}
              />
            );
          })
        )}
      </Group>

      <SectionHeader>{t('alerts.city')}</SectionHeader>
      <Group padded>
        <Body>{briefing.cityAction}</Body>
      </Group>
      <SectionHeader>{t('alerts.sentToCity')}</SectionHeader>
      <SectionFooter>{t('alerts.sentToCityBody')}</SectionFooter>

      <Button title={t('alerts.back')} variant="secondary" onPress={() => goBackOr(router, '/alerts')} style={{ marginTop: 12 }} testID="alert-back" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
});
