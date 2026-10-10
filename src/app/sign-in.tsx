/**
 * S-14 Sign-in sheet (plan §3.4 D3, §9.1, §23.A/§23.E): Apple (iOS only), Google, or a 6-digit email code. Opened by
 * requireSession() before the first server write (photo upload online, submit offline) or from Me / Settings; says
 * why ("one vote per person; your reports stay yours") and returns to where it was opened. "Not now" — or leaving the
 * sheet any other way — settles waiting callers with null; a completed sign-in settles them with the session once the
 * auth listener has mirrored it into the store. No spinners: button titles carry progress, errors are Callouts.
 */
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { t } from '@/i18n';
import { EMAIL_CODE_LENGTH, devSignIn, sendEmailCode, settleSignIn, signInWithApple, signInWithGoogle, type SignInResult, verifyEmailCode } from '@/services/auth';
import { refreshAll } from '@/services/refresh';
import { isSignInConfigured } from '@/services/supabaseClient';
import { isOfflineNow, useAppState } from '@/store/appStore';
import { Screen, goBackOr } from '@/ui/Screen';
import { Body, Button, Callout, Field, Group, SectionFooter, SectionHeader } from '@/ui/primitives';

/** One sentence per reason the sheet was opened for (requireSession reason, or `staff` from Settings). */
const WHY: Record<string, string> = {
  report: 'Sign in to send this report. Your draft is saved on this phone either way.',
  vote: 'One vote per person — sign in so yours counts.',
  comment: 'Comments are public record and carry a name or initials, so they need an account.',
  follow: 'Following a report sends you its status updates; that needs an account to send them to.',
  verify: 'Only neighbours with an account can confirm a fix, so nobody confirms it twice.',
  watch: 'Watch areas are saved to your account, so alerts follow you to a new phone.',
  staff: 'City staff sign in with their work email. The 6-digit code arrives the same way.',
};

type Step = 'pick' | 'code';
type Busy = 'apple' | 'google' | 'send' | 'verify' | 'dev' | null;

export default function SignInScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { reason } = useLocalSearchParams<{ reason?: string }>();
  const session = useAppState((s) => s.session);
  const offline = useAppState((s) => isOfflineNow(s));
  const configured = isSignInConfigured();
  const [step, setStep] = useState<Step>('pick');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Signed in (any path, including an email link): hand the session to whoever asked, then close.
  useEffect(() => {
    if (!session) return;
    settleSignIn(session);
    goBackOr(router, '/');
  }, [session, router]);

  // Swiped or backed away without "Not now": nobody may wait forever (a no-op once the session settled them).
  useEffect(() => navigation.addListener('beforeRemove', () => settleSignIn(null)), [navigation]);

  async function run(kind: Exclude<Busy, null>, action: () => Promise<SignInResult>) {
    setError(null);
    setBusy(kind);
    const res = await action();
    setBusy(null);
    if (!res.ok) {
      if (res.code !== 'cancelled') setError(res.message);
      return;
    }
    if (kind === 'send') setStep('code');
    else {
      setDone(true);
      void refreshAll(); // drafts parked as needs_sign_in send themselves now, not at the next foreground
    }
  }

  function dismiss() {
    settleSignIn(null);
    goBackOr(router, '/');
  }

  const why = WHY[reason ?? ''];
  const disabled = busy !== null || offline || !configured || done;
  const codeDigits = code.replace(/\D/g, '');
  const sendCode = () => void run('send', () => sendEmailCode(email));

  return (
    <Screen title={t('signIn.title')} largeTitle={t('signIn.title')} testID="sign-in">
      <Body style={{ marginBottom: 8 }}>{why ?? t('signIn.why')}</Body>
      {why ? <SectionFooter style={{ paddingTop: 0 }}>{t('signIn.why')}</SectionFooter> : null}
      {!configured ? <Callout icon="info" tone="amber" title="Sign-in is not set up on this build">Browsing works without an account. Ask the team for a build with Supabase configured.</Callout> : null}
      {configured && offline ? <Callout icon="offline" tone="amber" title="No signal">Sign-in needs a connection. Your drafts are saved on this phone and send after you sign in.</Callout> : null}
      {error ? <Callout icon="alert" tone="red" title={t('signIn.failed')}>{error}</Callout> : null}
      {done ? <Callout icon="checkCircle" tone="green" title="Signed in">Taking you back…</Callout> : null}

      {step === 'pick' ? (
        <>
          <SectionHeader>Continue with</SectionHeader>
          <Group padded style={{ gap: 10 }}>
            {Platform.OS === 'ios' ? <Button title={busy === 'apple' ? 'Waiting for Apple…' : t('signIn.apple')} icon="apple" onPress={() => void run('apple', signInWithApple)} disabled={disabled} testID="signin-apple" /> : null}
            <Button title={busy === 'google' ? 'Waiting for Google…' : t('signIn.google')} icon="google" variant="secondary" onPress={() => void run('google', signInWithGoogle)} disabled={disabled} testID="signin-google" />
          </Group>
          <SectionHeader>{t('signIn.email')}</SectionHeader>
          <Group>
            <Field label={t('signIn.emailLabel')} value={email} onChangeText={setEmail} placeholder="you@example.org" returnKeyType="send" onSubmitEditing={sendCode} testID="signin-email" last />
          </Group>
          <Button title={busy === 'send' ? 'Sending…' : t('signIn.sendCode')} variant="tonal" icon="mail" onPress={sendCode} disabled={disabled || email.trim().length === 0} testID="signin-send" />
          <SectionFooter>No password. The code expires in 10 minutes; your address is used for sign-in and nothing else.</SectionFooter>
          {__DEV__ ? (
            <>
              <Button title={busy === 'dev' ? 'Signing in…' : 'Developer: sign in as a test resident'} variant="ghost" icon="person" onPress={() => void run('dev', devSignIn)} disabled={disabled} style={{ marginTop: 10 }} testID="signin-dev" />
              <SectionFooter>Development builds only: a throwaway account from the local dev server (ROOTCAUSE_DEV_SESSION=1). Not in the App Store build.</SectionFooter>
            </>
          ) : null}
        </>
      ) : (
        <>
          <Callout icon="mail" tone="tint">{t('signIn.codeSent', { email: email.trim().toLowerCase() })}</Callout>
          <Group>
            <Field label={t('signIn.codeLabel')} value={code} onChangeText={setCode} placeholder="123456" maxLength={EMAIL_CODE_LENGTH} autoFocus returnKeyType="done" onSubmitEditing={() => void run('verify', () => verifyEmailCode(email, code))} testID="signin-code" last />
          </Group>
          <Button title={busy === 'verify' ? 'Checking…' : t('signIn.verify')} icon="check" onPress={() => void run('verify', () => verifyEmailCode(email, code))} disabled={disabled || codeDigits.length !== EMAIL_CODE_LENGTH} testID="signin-verify" />
          <Button title={busy === 'send' ? 'Sending…' : 'Send a new code'} variant="ghost" onPress={sendCode} disabled={disabled} style={{ marginTop: 6 }} />
          <Button
            title="Use a different email"
            variant="ghost"
            onPress={() => {
              setStep('pick');
              setCode('');
              setError(null);
            }}
            disabled={busy !== null}
          />
        </>
      )}
      <Button title={t('signIn.cancel')} variant="secondary" onPress={dismiss} disabled={busy !== null} style={{ marginTop: 16 }} testID="signin-cancel" />
    </Screen>
  );
}
