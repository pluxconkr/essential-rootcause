/**
 * S-14 deep-link target (plan §3.4 "deep link rootcause://auth/callback", §23.B): finishes a sign-in started by the
 * email link — a PKCE code, a token hash or implicit-flow tokens — through supabase.auth and replaces to Home. The
 * app types the 6-digit code by default, so this is the fallback path. It never blocks and says what it is doing.
 */
import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { completeSignInFromLink, parseAuthLink } from '@/services/auth';
import { useAppState } from '@/store/appStore';
import { Screen } from '@/ui/Screen';
import { Body, Button, Callout } from '@/ui/primitives';

/** How long the initial URL may take to arrive before the screen says no link was found. */
export const LINK_GRACE_MS = 1500;

function flatten(params: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    const first = Array.isArray(v) ? v[0] : v;
    if (typeof first === 'string') out[k] = first;
  }
  return out;
}

export default function AuthCallbackScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const url = Linking.useURL();
  const session = useAppState((s) => s.session);
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = useState<string | null>(null);
  const started = useRef(false);
  // The query part as a string, so the effect below depends on a stable value rather than a fresh params object.
  const query = new URLSearchParams(flatten(params)).toString();

  useEffect(() => {
    if (started.current) return;
    const link = parseAuthLink(url) ?? (query ? parseAuthLink(`rootcause://auth/callback?${query}`) : null);
    if (!link) {
      const timer = setTimeout(() => {
        if (started.current) return;
        setState('failed');
        setMessage('No sign-in link was found. Open the app and request a new code.');
      }, LINK_GRACE_MS);
      return () => clearTimeout(timer);
    }
    started.current = true;
    void completeSignInFromLink(link).then((res) => {
      if (res.ok) {
        setState('done');
        router.replace('/');
        return;
      }
      setState('failed');
      setMessage(res.message);
    });
  }, [url, query, router]);

  // The auth listener mirrored the session: nothing left to do here.
  useEffect(() => {
    if (session && state !== 'failed') router.replace('/');
  }, [session, state, router]);

  return (
    <Screen largeTitle="Finishing sign-in" testID="auth-callback">
      {state === 'failed' ? (
        <>
          <Callout icon="alert" tone="red" title="That link did not work">
            {message ?? ''}
          </Callout>
          <Button title="Back to the app" onPress={() => router.replace('/')} testID="auth-callback-back" />
        </>
      ) : (
        <Body>{state === 'done' ? 'Signed in. Taking you back…' : 'Checking the link from your email…'}</Body>
      )}
    </Screen>
  );
}
