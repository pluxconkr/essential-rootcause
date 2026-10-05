/**
 * S-11 Alerts & preferences (spec R14; plan §9.1, §9.3): quiet hours (saved on the phone first, mirrored to the
 * account when signed in and online), the watch areas entry, the SMS row (arrives with phone verification in M2 —
 * shown disabled, so nobody looks for it), and the account: who is signed in, sign out, delete my data (the App Store
 * account-deletion path, plan §23.C), and staff sign-in through the same email-code sheet. Nothing here blocks on the
 * network; no spinners — titles carry progress.
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Platform } from 'react-native';

import { MeProfileSchema, type AuthSession } from '@/domain/types';
import { t } from '@/i18n';
import { api } from '@/services/apiClient';
import { deleteMyData, signOut } from '@/services/auth';
import { actions, isOfflineNow, useAppState } from '@/store/appStore';
import { Screen } from '@/ui/Screen';
import { Callout, Cell, Group, SectionFooter, SectionHeader, Segmented } from '@/ui/primitives';
import { colors } from '@/ui/theme';

type QuietPick = '22-7' | '23-6' | 'off';

/** spec R14: quiet hours 10pm–7am except emergency (the default); one later window; or none. */
export const QUIET_OPTIONS: readonly { value: QuietPick; label: string; window: { start: string; end: string } | null }[] = [
  { value: '22-7', label: '10pm–7am', window: { start: '22:00', end: '07:00' } },
  { value: '23-6', label: '11pm–6am', window: { start: '23:00', end: '06:00' } },
  { value: 'off', label: 'Off', window: null },
];

export function quietPick(window: { start: string; end: string } | null): QuietPick {
  if (!window) return 'off';
  return QUIET_OPTIONS.find((o) => o.window?.start === window.start && o.window?.end === window.end)?.value ?? '22-7';
}

const PROVIDER_LABEL: Record<AuthSession['provider'], string> = { apple: 'Apple', google: 'Google', email: 'Email code' };

const roleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);

export default function SettingsScreen() {
  const router = useRouter();
  const prefs = useAppState((s) => s.prefs);
  const session = useAppState((s) => s.session);
  const offline = useAppState((s) => isOfflineNow(s));
  const [busy, setBusy] = useState<'signout' | 'delete' | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);

  function setQuiet(pick: QuietPick) {
    const window = QUIET_OPTIONS.find((o) => o.value === pick)?.window ?? null;
    actions.savePrefs({ ...prefs, quietHours: window });
    // Mirror to the account so server-side pushes honour it (plan §9.4); best effort, the phone copy is the source.
    if (session && !offline) void api('/api/v1/me', MeProfileSchema, { method: 'PATCH', body: { quietHours: window } });
  }

  async function doSignOut() {
    setAccountError(null);
    setBusy('signout');
    await signOut();
    setBusy(null);
  }

  function confirmDelete() {
    const go = async () => {
      setAccountError(null);
      setBusy('delete');
      const res = await deleteMyData();
      setBusy(null);
      if (res.ok) router.replace('/');
      else setAccountError(res.message);
    };
    if (Platform.OS === 'web') {
      if (globalThis.confirm?.(`${t('settings.deleteData')}? ${t('settings.deleteHint')}`)) void go();
      return;
    }
    Alert.alert(t('settings.deleteData'), t('settings.deleteHint'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('settings.deleteData'), style: 'destructive', onPress: () => void go() },
    ]);
  }

  return (
    <Screen title={t('settings.title')} largeTitle={t('settings.title')} fallback="/me" testID="settings">
      <SectionHeader>{t('settings.watchAreas')}</SectionHeader>
      <Group>
        <Cell icon="pin" iconColor={colors.tint} title={t('settings.watchAreas')} subtitle={prefs.home ? `Home · ${prefs.home.radiusM} m radius on this phone` : 'No home area yet'} accessory="chevron" onPress={() => router.push('/watch-areas')} testID="settings-watch-areas" last />
      </Group>
      <SectionFooter>{t('settings.watchHint')}</SectionFooter>

      <SectionHeader>{t('settings.quiet')}</SectionHeader>
      <Group padded>
        <Segmented<QuietPick> options={QUIET_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} value={quietPick(prefs.quietHours)} onChange={setQuiet} label={t('settings.quiet')} />
      </Group>
      <SectionFooter>{t('settings.quietHint')}</SectionFooter>

      <SectionHeader>{t('settings.phone')}</SectionHeader>
      <Group>
        <Cell icon="phone" iconColor={colors.ink4} title={t('settings.phone')} subtitle="Arrives with phone verification in the next build. Until then push and in-app alerts carry everything." last />
      </Group>
      <SectionFooter>{t('settings.phoneHint')}</SectionFooter>

      <SectionHeader>{t('settings.account')}</SectionHeader>
      {accountError ? (
        <Callout icon="alert" tone="red" title="That did not work">
          {accountError}
        </Callout>
      ) : null}
      <Group>
        {session ? (
          <>
            <Cell icon="person" iconColor={colors.tint} title={session.displayName ?? session.email ?? 'Signed in'} subtitle={[session.email, PROVIDER_LABEL[session.provider], roleLabel(session.role)].filter(Boolean).join(' · ')} testID="settings-identity" />
            <Cell icon="signIn" iconColor={colors.tint} title={busy === 'signout' ? 'Signing out…' : t('signIn.out')} onPress={busy ? undefined : () => void doSignOut()} testID="settings-sign-out" />
            <Cell icon="trash" iconColor={colors.red} title={busy === 'delete' ? 'Deleting…' : t('settings.deleteData')} subtitle={t('settings.deleteHint')} onPress={busy || offline ? undefined : confirmDelete} testID="settings-delete" last />
          </>
        ) : (
          <>
            <Cell icon="signIn" iconColor={colors.tint} title={t('signIn.title')} subtitle={t('signIn.why')} accessory="chevron" onPress={() => router.push('/sign-in')} testID="settings-sign-in" />
            <Cell icon="shield" iconColor={colors.tint} title={t('settings.staff')} subtitle="City staff use their work email; the same 6-digit code." accessory="chevron" onPress={() => router.push({ pathname: '/sign-in', params: { reason: 'staff' } })} testID="settings-staff" last />
          </>
        )}
      </Group>
      {session && offline ? <SectionFooter>Deleting your data needs a signal; signing out works offline.</SectionFooter> : null}
    </Screen>
  );
}
