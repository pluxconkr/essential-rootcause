/**
 * Demo scenarios (plan §9.5): `calm`, `storm` (an archived forecast shifted to tonight), `verify` (one of your
 * reports is fixed and waiting for your confirmation). Demo reports are deterministic, generated at boot from
 * the scenario (never persisted) and labelled wherever they appear. Deep link: rootcause://?demo=storm
 */
import { buildDemoReports, DEMO_SCENARIOS } from '@/domain/demo';
import { PILOT } from '@/domain/pilot';
import { formatDateTime, nowMs } from '@/domain/time';
import type { DemoScenario } from '@/domain/types';
import { t } from '@/i18n';
import { actions, getState } from '@/store/appStore';

export function isDemoScenario(s: string | null | undefined): s is DemoScenario {
  return s === 'calm' || s === 'storm' || s === 'verify';
}

/** Switch scenarios (or off with null). Writes the setting, then regenerates the labelled data. */
export function applyDemoScenario(scenario: DemoScenario | null): void {
  const def = scenario ? DEMO_SCENARIOS[scenario] : null;
  actions.patchSettings({ demoScenario: scenario, demoClockOffsetMs: def ? def.clockOffsetMs : 0 });
  actions.setDemoReports(scenario ? buildDemoReports(scenario, PILOT.center) : []);
}

/** At boot: re-materialise the active scenario (its data is never persisted). */
export function restoreDemoScenario(): void {
  const s = getState().settings.demoScenario;
  if (s) actions.setDemoReports(buildDemoReports(s, PILOT.center));
}

/** The label shown under titles while a scenario is active, or null. */
export function demoNote(): string | null {
  const s = getState().settings.demoScenario;
  return s ? t('demo.label', { when: formatDateTime(nowMs()) }) : null;
}
