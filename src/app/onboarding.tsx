/**
 * S-00 Onboarding. Three choices and nothing else: where you want alerts (home area), which categories, quiet
 * hours. No sign-in here (owner decision D3: sign-in is asked at the first write). The home area stays on this
 * phone unless the resident later saves it as a watch area.
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';

import { PILOT } from '@/domain/pilot';
import { CATEGORIES, CATEGORY_LABEL } from '@/domain/taxonomy';
import type { Category } from '@/domain/types';
import { t } from '@/i18n';
import { acquireLocation } from '@/services/location';
import { actions, useAppState } from '@/store/appStore';
import { Screen } from '@/ui/Screen';
import { Body, Button, Checkbox, Group, SectionFooter, SectionHeader, Toggle } from '@/ui/primitives';

export default function OnboardingScreen() {
  const router = useRouter();
  const prefs = useAppState((s) => s.prefs);
  const locationStatus = useAppState((s) => s.locationStatus);
  const [home, setHome] = useState(prefs.home);
  const [categories, setCategories] = useState<Category[]>(prefs.categories);
  const [quiet, setQuiet] = useState(prefs.quietHours != null);
  const [busy, setBusy] = useState(false);

  async function locateMe() {
    setBusy(true);
    const fix = await acquireLocation();
    setBusy(false);
    if (fix) setHome({ lat: fix.lat, lng: fix.lng, radiusM: PILOT.homeRadiusM });
  }

  function start() {
    actions.savePrefs({ ...prefs, home: home ?? { ...PILOT.center, radiusM: PILOT.homeRadiusM }, categories: categories.length ? categories : prefs.categories, quietHours: quiet ? { start: '22:00', end: '07:00' } : null }, { finishOnboarding: true });
    router.replace('/');
  }

  return (
    <Screen largeTitle={t('onboarding.title')} testID="onboarding">
      <Body style={{ marginBottom: 16 }}>{t('onboarding.lede')}</Body>
      <SectionHeader>{t('onboarding.home')}</SectionHeader>
      <Group padded>
        <Body>{home ? `Home area set · ${home.radiusM} m radius` : locationStatus === 'denied' ? `Location not allowed — using the ${PILOT.name} centre.` : 'Not set yet.'}</Body>
        <Button title={busy ? 'Finding you…' : 'Use my location'} variant="tonal" icon="location" onPress={() => void locateMe()} disabled={busy} style={{ marginTop: 10 }} testID="onboarding-location" />
      </Group>
      <SectionFooter>{t('onboarding.homeHint')}</SectionFooter>
      <SectionHeader>Categories</SectionHeader>
      <Group padded>
        {CATEGORIES.map((c) => (
          <Checkbox key={c} label={CATEGORY_LABEL[c]} checked={categories.includes(c)} onChange={(v) => setCategories((prev) => (v ? [...prev, c] : prev.filter((x) => x !== c)))} />
        ))}
      </Group>
      <SectionHeader>Quiet hours</SectionHeader>
      <Group>
        <Toggle label="10pm–7am" value={quiet} onChange={setQuiet} hint="Emergency alerts always break through." last />
      </Group>
      <Button title={t('onboarding.start')} onPress={start} style={{ marginTop: 16 }} testID="onboarding-start" />
    </Screen>
  );
}
