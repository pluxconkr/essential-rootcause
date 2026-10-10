/**
 * S-11 Alerts & preferences (spec R14; plan §9.1, §9.3, §9.4, §3.12 D11): quiet hours (saved on the phone first,
 * mirrored to the account when signed in and online), the watch areas entry, phone & SMS — add a number, verify it
 * with the 6-digit code Twilio Verify texts (POST /me/phone, /me/phone/check), then opt in to texts for emergency
 * alerts and status changes (PATCH /me smsOptIn, refused by the server until the number is verified) — and the
 * account: who is signed in, sign out, delete my data (the App Store account-deletion path, plan §23.C), and staff
 * sign-in through the same email-code sheet. Nothing here blocks on the network; no spinners — titles carry
 * progress; offline is a line, not an error.
 */
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform } from 'react-native';

import { E164_RE, MeProfileSchema, PHONE_CODE_LENGTH, type AuthSession, type MeProfile } from '@/domain/types';
import { t } from '@/i18n';
import { api, meApi } from '@/services/apiClient';
import { deleteMyData, refreshProfile, signOut } from '@/services/auth';
import { actions, isOfflineNow, useAppState } from '@/store/appStore';
import { Screen } from '@/ui/Screen';
import type { IconName } from '@/ui/icons';
import { Button, Callout, Cell, Field, Group, SectionFooter, SectionHeader, Segmented, Toggle } from '@/ui/primitives';
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

type PhoneBusy = 'send' | 'verify' | 'optin' | null;

interface PhoneNote {
  tone: 'red' | 'green' | 'amber';
  icon: IconName;
  title: string;
  body: string;
}

export default function SettingsScreen() {
  const router = useRouter();
  const prefs = useAppState((s) => s.prefs);
  const session = useAppState((s) => s.session);
  const offline = useAppState((s) => isOfflineNow(s));
  const [busy, setBusy] = useState<'signout' | 'delete' | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  // Phone & SMS: the account's state from GET /me (fetched once, signed in and online), then what this screen changed.
  const [profile, setProfile] = useState<MeProfile | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sentLast4, setSentLast4] = useState<string | null>(null);
  const [phoneBusy, setPhoneBusy] = useState<PhoneBusy>(null);
  const [phoneNote, setPhoneNote] = useState<PhoneNote | null>(null);
  const userId = session?.userId ?? null;

  useEffect(() => {
    if (!userId || offline) return;
    let alive = true;
    void refreshProfile().then((p) => {
      if (alive && p) setProfile(p);
    });
    return () => {
      alive = false;
    };
  }, [userId, offline]);

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

  // ---------- phone & SMS ----------

  const verified = profile?.phoneVerified === true;
  const last4 = sentLast4 ?? profile?.phoneLast4 ?? null;
  const pending = !verified && last4 !== null;
  const normalisedPhone = phone.replace(/[\s().-]/g, '');
  const codeDigits = code.replace(/\D/g, '');

  async function sendCode() {
    if (!E164_RE.test(normalisedPhone)) {
      setPhoneNote({ tone: 'amber', icon: 'info', title: 'Check the number', body: 'Use the international form, e.g. +1 732 555 0100. US and Canadian mobile numbers only.' });
      return;
    }
    setPhoneNote(null);
    setPhoneBusy('send');
    const res = await meApi.startPhone(normalisedPhone);
    setPhoneBusy(null);
    if (!res.ok) {
      setPhoneNote({ tone: res.status === 429 ? 'amber' : 'red', icon: 'alert', title: 'No code sent', body: res.message });
      return;
    }
    setSentLast4(res.data.last4);
    setCode('');
    setProfile((p) => (p ? { ...p, phoneVerified: false, phoneLast4: res.data.last4, smsOptIn: false } : p));
    setPhoneNote({ tone: 'green', icon: 'phone', title: 'Code sent', body: `Enter the ${PHONE_CODE_LENGTH}-digit code from the text. It expires in 10 minutes.` });
  }

  async function verifyCode() {
    setPhoneNote(null);
    setPhoneBusy('verify');
    const res = await meApi.checkPhone(codeDigits);
    setPhoneBusy(null);
    if (!res.ok) {
      setPhoneNote({ tone: 'red', icon: 'alert', title: 'Not verified', body: res.message });
      return;
    }
    setProfile(res.data);
    setSentLast4(null);
    setCode('');
    setPhoneNote({ tone: 'green', icon: 'checkCircle', title: 'Number verified', body: 'You can switch on text messages below.' });
  }

  async function setSmsOptIn(on: boolean) {
    if (!profile || phoneBusy) return;
    const before = profile;
    setProfile({ ...profile, smsOptIn: on });
    setPhoneBusy('optin');
    const res = await meApi.patch({ smsOptIn: on });
    setPhoneBusy(null);
    if (!res.ok) {
      setProfile(before);
      setPhoneNote({ tone: 'red', icon: 'alert', title: 'That did not save', body: res.message });
      return;
    }
    setProfile(res.data);
  }

  const phoneTitle = verified ? t('settings.phoneVerified', { last4: last4 ?? '' }) : pending ? t('settings.phoneSent', { last4: last4 ?? '' }) : profile ? t('settings.phoneNone') : 'Checking your account…';
  const phoneSubtitle = verified ? 'Status updates and emergency alerts can reach this number.' : pending ? 'Enter the code from the text, or send a new one.' : t('settings.phoneHint');

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

      <SectionHeader>{t('settings.phoneGroup')}</SectionHeader>
      {phoneNote ? (
        <Callout icon={phoneNote.icon} tone={phoneNote.tone} title={phoneNote.title}>
          {phoneNote.body}
        </Callout>
      ) : null}
      {!session ? (
        <Callout icon="signIn" tone="tint" title={t('settings.phoneSignIn')}>
          {t('settings.phoneHint')}
        </Callout>
      ) : offline ? (
        <Group>
          <Cell icon="phone" iconColor={colors.ink4} title={t('settings.phone')} subtitle="Needs a signal" last />
        </Group>
      ) : (
        <>
          <Group>
            <Cell icon="phone" iconColor={verified ? colors.green : colors.tint} title={phoneTitle} subtitle={phoneSubtitle} />
            {verified ? null : <Field label={t('settings.phoneNumber')} value={phone} onChangeText={setPhone} placeholder="+1 732 555 0100" keyboardType="phone-pad" textContentType="telephoneNumber" autoComplete="tel" returnKeyType="send" onSubmitEditing={() => void sendCode()} testID="settings-phone" />}
            {pending ? <Field label={t('settings.phoneCode')} value={code} onChangeText={setCode} placeholder="123456" maxLength={PHONE_CODE_LENGTH} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="sms-otp" returnKeyType="done" onSubmitEditing={() => void verifyCode()} testID="settings-phone-code" /> : null}
            {verified ? <Toggle label={t('settings.smsOptIn')} value={profile?.smsOptIn === true} onChange={(v) => void setSmsOptIn(v)} icon="bell" last /> : <Cell icon="bell" iconColor={colors.ink4} title={t('settings.smsOptIn')} subtitle={t('settings.smsOptInHint')} last />}
          </Group>
          {verified ? null : <Button title={phoneBusy === 'send' ? 'Sending…' : pending ? 'Send a new code' : t('settings.sendCode')} variant="tonal" icon="phone" onPress={() => void sendCode()} disabled={phoneBusy !== null || normalisedPhone.length === 0} testID="settings-phone-send" />}
          {pending ? <Button title={phoneBusy === 'verify' ? 'Checking…' : t('signIn.verify')} icon="check" onPress={() => void verifyCode()} disabled={phoneBusy !== null || codeDigits.length !== PHONE_CODE_LENGTH} style={{ marginTop: 6 }} testID="settings-phone-verify" /> : null}
        </>
      )}
      <SectionFooter>{t('settings.smsTerms')}</SectionFooter>

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
