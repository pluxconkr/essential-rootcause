/**
 * services/auth.ts without a device (plan §9.3, §23.A/§23.B): the requireSession() pending registry — immediate when
 * signed in, one sheet for many callers, settled by the session or by "Not now", immediate null on a build without
 * Supabase — the token provider, the auth-state mirror (next-tick settle, role from GET /api/v1/me), the input checks
 * that never reach Supabase, and parseAuthLink() for every email-link variant. expo-router's imperative router and
 * the Supabase client are faked; everything else is the real store over the in-memory kv.
 */
import type { MeProfile } from '@/domain/types';
import { RAW_TOKEN_LINK_MESSAGE, UNEXPECTED_LINK_MESSAGE, WRONG_ADDRESS_LINK_MESSAGE, applySession, completeSignInFromLink, getAccessToken, hasPendingSignIn, initAuth, parseAuthLink, refreshProfile, requireSession, sendEmailCode, setTokenProvider, settleSignIn, signOut, verifyEmailCode } from '@/services/auth';
import { actions, getState, hydrate, setState } from '@/store/appStore';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => false };
jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
}));

const mockSupabase = {
  configured: true,
  listener: null as ((event: string, session: unknown) => void) | null,
  auth: {
    getSession: jest.fn(async () => ({ data: { session: { access_token: 'tok_123' } } })),
    onAuthStateChange: jest.fn((cb: (event: string, session: unknown) => void) => {
      mockSupabase.listener = cb;
      return { data: { subscription: { unsubscribe: jest.fn() } } };
    }),
    signInWithOtp: jest.fn(async () => ({ error: null })),
    verifyOtp: jest.fn(async () => ({ error: null })),
    exchangeCodeForSession: jest.fn(async () => ({ error: null })),
    getUser: jest.fn(async () => ({ data: { user: { email: 'jane@example.org' } } })),
    signInWithIdToken: jest.fn(async () => ({ error: null })),
    signOut: jest.fn(async () => ({ error: null })),
    startAutoRefresh: jest.fn(),
    stopAutoRefresh: jest.fn(),
  },
};
jest.mock('@/services/supabaseClient', () => ({
  get supabase() {
    return mockSupabase.configured ? mockSupabase : null;
  },
  isSignInConfigured: () => mockSupabase.configured,
  authCallbackUrl: () => 'rootcause://auth/callback',
  AUTH_KV_PREFIX: 'auth:',
  clearAuthStorage: () => {
    // Same loop as the real module: every key supabase-js persisted under the auth namespace.
    const { kv } = jest.requireActual('@/data/kv') as { kv: { keys(): string[]; remove(k: string): void } };
    for (const k of kv.keys()) if (k.startsWith('auth:sb-')) kv.remove(k);
  },
}));

const SESSION = { userId: 'u_jane', role: 'resident', displayName: 'Jane Doe', email: 'jane@example.org', provider: 'email' } as const;
const PROFILE: MeProfile = { userId: 'u_jane', role: 'inspector', displayName: 'Jane Q. Doe', email: 'jane@example.org', provider: 'apple', phoneVerified: false, smsOptIn: false, quietHours: null, stats: { filed: 0, resolved: 0, votes: 0 }, watchAreas: [], createdAt: '2026-01-01T00:00:00.000Z' };
const fakeUser = (over: Record<string, unknown> = {}) => ({ user: { id: 'u_jane', email: 'jane@example.org', app_metadata: { provider: 'apple' }, user_metadata: { full_name: 'Jane Doe' }, ...over } });

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush(n = 4) {
  for (let i = 0; i < n; i++) await tick();
}

beforeEach(() => {
  hydrate();
  actions.setSession(null);
  setState({ network: { online: true, type: 'wifi' } });
  mockSupabase.configured = true;
  mockSupabase.listener = null;
  for (const fn of Object.values(mockSupabase.auth)) fn.mockClear();
  mockRouter.push.mockReset();
  settleSignIn(null);
  setTokenProvider(async () => null);
});

describe('requireSession() pending registry', () => {
  test('signed in: resolves at once with the store session and opens nothing', async () => {
    actions.setSession(SESSION);
    expect(await requireSession('vote')).toEqual(SESSION);
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(hasPendingSignIn()).toBe(false);
  });

  test('signed out: one sheet for many callers, all settled with the session when sign-in completes', async () => {
    const a = requireSession('vote');
    const b = requireSession('follow');
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/sign-in', params: { reason: 'vote' } });
    expect(hasPendingSignIn()).toBe(true);
    settleSignIn(SESSION);
    expect(await a).toEqual(SESSION);
    expect(await b).toEqual(SESSION);
    expect(hasPendingSignIn()).toBe(false);
  });

  test('"Not now" settles every caller with null; the next request opens the sheet again', async () => {
    const p = requireSession('comment');
    settleSignIn(null);
    expect(await p).toBeNull();
    expect(hasPendingSignIn()).toBe(false);
    const again = requireSession('report');
    expect(mockRouter.push).toHaveBeenCalledTimes(2);
    settleSignIn(null);
    expect(await again).toBeNull();
  });

  test('a build without Supabase configuration resolves null at once — the caller shows "Sign in to vote"', async () => {
    mockSupabase.configured = false;
    expect(await requireSession('vote')).toBeNull();
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(hasPendingSignIn()).toBe(false);
  });

  test('when no navigator can open the sheet, nobody hangs', async () => {
    mockRouter.push.mockImplementationOnce(() => {
      throw new Error('no navigator mounted');
    });
    expect(await requireSession('verify')).toBeNull();
    expect(hasPendingSignIn()).toBe(false);
  });
});

describe('token provider', () => {
  test('null by default, whatever is installed afterwards, and never throws', async () => {
    expect(await getAccessToken()).toBeNull();
    setTokenProvider(async () => 'abc');
    expect(await getAccessToken()).toBe('abc');
    setTokenProvider(async () => {
      throw new Error('keychain locked');
    });
    expect(await getAccessToken()).toBeNull();
  });
});

describe('initAuth(): mirror of the Supabase auth state', () => {
  test('installs the provider, mirrors SIGNED_IN into the store, settles callers on the next tick and learns the role from /me', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(PROFILE), { status: 200, headers: { 'content-type': 'application/json' } }));
    const stop = initAuth();
    try {
      expect(mockSupabase.auth.onAuthStateChange).toHaveBeenCalledTimes(1);
      expect(await getAccessToken()).toBe('tok_123');
      const waiting = requireSession('vote');
      mockSupabase.listener!('SIGNED_IN', fakeUser());
      // The store already has the session, callers are settled a tick later (no auth calls inside the callback).
      expect(getState().session).toEqual({ userId: 'u_jane', role: 'resident', displayName: 'Jane Doe', email: 'jane@example.org', provider: 'apple' });
      expect(hasPendingSignIn()).toBe(true);
      expect(await waiting).toMatchObject({ userId: 'u_jane', provider: 'apple' });
      await flush();
      expect(getState().session).toMatchObject({ role: 'inspector', displayName: 'Jane Q. Doe' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(/\/api\/v1\/me$/);
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok_123');
      // A refresh keeps what was learned; a sign-out clears it.
      mockSupabase.listener!('TOKEN_REFRESHED', fakeUser());
      expect(getState().session?.role).toBe('inspector');
      mockSupabase.listener!('SIGNED_OUT', null);
      expect(getState().session).toBeNull();
      await flush();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      fetchSpy.mockRestore();
    }
  });

  test('without Supabase configuration the provider stays signed-out and nothing subscribes', async () => {
    mockSupabase.configured = false;
    const stop = initAuth();
    try {
      expect(await getAccessToken()).toBeNull();
      expect(mockSupabase.auth.onAuthStateChange).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  test('applySession keeps the role learned for the same user and starts over for another', () => {
    actions.setSession({ ...SESSION, role: 'director' });
    expect(applySession(fakeUser() as never)?.role).toBe('director');
    expect(applySession(fakeUser({ id: 'u_other', user_metadata: {} }) as never)).toEqual({ userId: 'u_other', role: 'resident', displayName: null, email: 'jane@example.org', provider: 'apple' });
    expect(applySession(null)).toBeNull();
    expect(getState().session).toBeNull();
  });

  test('refreshProfile is a no-op offline or signed out', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    expect(await refreshProfile()).toBeNull();
    actions.setSession(SESSION);
    setState({ network: { online: false, type: 'NONE' } });
    expect(await refreshProfile()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('email code: checks that never reach Supabase', () => {
  test('sendEmailCode validates and normalises the address, maps rate limits, respects offline', async () => {
    expect(await sendEmailCode('not an email')).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(mockSupabase.auth.signInWithOtp).not.toHaveBeenCalled();
    expect(await sendEmailCode('  Jane@Example.org ')).toEqual({ ok: true });
    expect(mockSupabase.auth.signInWithOtp).toHaveBeenCalledWith({ email: 'jane@example.org', options: { shouldCreateUser: true, emailRedirectTo: 'rootcause://auth/callback' } });
    mockSupabase.auth.signInWithOtp.mockResolvedValueOnce({ error: { status: 429, code: 'over_email_send_rate_limit', message: 'rate limit' } } as never);
    expect(await sendEmailCode('jane@example.org')).toMatchObject({ ok: false, code: 'provider', message: expect.stringMatching(/Too many codes/) });
    setState({ network: { online: false, type: 'NONE' } });
    expect(await sendEmailCode('jane@example.org')).toMatchObject({ ok: false, code: 'offline' });
    mockSupabase.configured = false;
    expect(await sendEmailCode('jane@example.org')).toMatchObject({ ok: false, code: 'unavailable' });
  });

  test('verifyEmailCode needs six digits, strips separators, and reports a wrong code without throwing', async () => {
    expect(await verifyEmailCode('jane@example.org', '12 34')).toMatchObject({ ok: false, code: 'invalid_code' });
    expect(mockSupabase.auth.verifyOtp).not.toHaveBeenCalled();
    expect(await verifyEmailCode('Jane@Example.org', '123-456')).toEqual({ ok: true });
    expect(mockSupabase.auth.verifyOtp).toHaveBeenCalledWith({ email: 'jane@example.org', token: '123456', type: 'email' });
    mockSupabase.auth.verifyOtp.mockResolvedValueOnce({ error: { message: 'Token has expired or is invalid' } } as never);
    expect(await verifyEmailCode('jane@example.org', '000000')).toMatchObject({ ok: false, code: 'invalid_code', message: expect.stringMatching(/did not work/) });
  });

  test('signOut: global when online, local when offline, store cleared either way', async () => {
    actions.setSession(SESSION);
    await signOut();
    expect(mockSupabase.auth.signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(getState().session).toBeNull();
    actions.setSession(SESSION);
    setState({ network: { online: false, type: 'NONE' } });
    await signOut();
    expect(mockSupabase.auth.signOut).toHaveBeenLastCalledWith({ scope: 'local' });
    expect(getState().session).toBeNull();
  });
});

describe('parseAuthLink()', () => {
  test('recognises the PKCE code and the token hash, refuses raw tokens, and surfaces provider errors', () => {
    expect(parseAuthLink(null)).toBeNull();
    expect(parseAuthLink('rootcause://auth/callback')).toBeNull();
    expect(parseAuthLink('rootcause://')).toBeNull();
    expect(parseAuthLink('rootcause://auth/callback?code=abc-123')).toEqual({ kind: 'code', code: 'abc-123' });
    expect(parseAuthLink('https://app.example/auth/callback?token_hash=h4sh&type=magiclink')).toEqual({ kind: 'token_hash', tokenHash: 'h4sh', type: 'magiclink' });
    expect(parseAuthLink('rootcause://auth/callback?token_hash=h4sh')).toEqual({ kind: 'token_hash', tokenHash: 'h4sh', type: 'email' });
    // Raw session tokens in a link are never accepted (login CSRF): the resident is told to use the code instead.
    expect(parseAuthLink('rootcause://auth/callback#access_token=at&refresh_token=rt&expires_in=3600&token_type=bearer')).toEqual({ kind: 'error', message: RAW_TOKEN_LINK_MESSAGE });
    expect(parseAuthLink('rootcause://auth/callback?x=1#access_token=at')).toEqual({ kind: 'error', message: RAW_TOKEN_LINK_MESSAGE });
    expect(parseAuthLink('rootcause://auth/callback#error=access_denied&error_description=Email+link+is+invalid+or+has+expired')).toEqual({ kind: 'error', message: 'Email link is invalid or has expired' });
  });
});

describe('completeSignInFromLink()', () => {
  beforeEach(() => {
    mockSupabase.auth.verifyOtp.mockClear();
    mockSupabase.auth.exchangeCodeForSession.mockClear();
    setState({ network: { online: true, type: 'WIFI' } });
  });

  test('a token-hash link out of the blue is ignored; one that follows a code request on this phone is redeemed once', async () => {
    const link = { kind: 'token_hash', tokenHash: 'h4sh', type: 'email' } as const;
    expect(await completeSignInFromLink(link)).toEqual({ ok: false, code: 'provider', message: UNEXPECTED_LINK_MESSAGE });
    expect(mockSupabase.auth.verifyOtp).not.toHaveBeenCalled();
    expect(await sendEmailCode('jane@example.org')).toEqual({ ok: true });
    expect(await completeSignInFromLink(link)).toEqual({ ok: true });
    expect(mockSupabase.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'h4sh', type: 'email' });
    // The pending sign-in is consumed: the same link cannot be replayed into a second session.
    expect(await completeSignInFromLink(link)).toMatchObject({ ok: false, message: UNEXPECTED_LINK_MESSAGE });
    expect(mockSupabase.auth.verifyOtp).toHaveBeenCalledTimes(1);
  });

  test('a PKCE code is exchanged (the stored verifier is the proof), raw tokens never reach the client', async () => {
    expect(await completeSignInFromLink({ kind: 'code', code: 'abc-123' })).toEqual({ ok: true });
    expect(mockSupabase.auth.exchangeCodeForSession).toHaveBeenCalledWith('abc-123');
    expect(await completeSignInFromLink({ kind: 'error', message: RAW_TOKEN_LINK_MESSAGE })).toEqual({ ok: false, code: 'provider', message: RAW_TOKEN_LINK_MESSAGE });
    expect(mockSupabase.auth.verifyOtp).not.toHaveBeenCalled();
  });
});

describe('sign-out and link safety after the review', () => {
  test('an offline sign-out drops the supabase-js tokens even when auth-js refused to clear an expired session', async () => {
    const { kv } = jest.requireActual('@/data/kv') as { kv: { set(k: string, v: unknown): void; get<T>(k: string): T | null } };
    kv.set('auth:sb-test-auth-token', JSON.stringify({ access_token: 'stale', refresh_token: 'rt' }));
    mockSupabase.auth.signOut.mockResolvedValueOnce({ error: { name: 'AuthRetryableFetchError', message: 'Network request failed', status: 0 } } as never).mockResolvedValueOnce({ error: { name: 'AuthRetryableFetchError', message: 'Network request failed', status: 0 } } as never);
    setState({ network: { online: false, type: 'NONE' }, session: SESSION });
    await signOut();
    expect(kv.get('auth:sb-test-auth-token')).toBeNull();
    expect(getState().session).toBeNull();
  });

  test('a token-hash link that signs in a different address than the pending one is undone and refused', async () => {
    setState({ network: { online: true, type: 'WIFI' } });
    expect(await sendEmailCode('jane@example.org')).toEqual({ ok: true });
    mockSupabase.auth.getUser.mockResolvedValueOnce({ data: { user: { email: 'mallory@example.org' } } } as never);
    mockSupabase.auth.signOut.mockClear();
    const res = await completeSignInFromLink({ kind: 'token_hash', tokenHash: 'h4sh', type: 'magiclink' });
    expect(res).toEqual({ ok: false, code: 'provider', message: WRONG_ADDRESS_LINK_MESSAGE });
    expect(mockSupabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    // The pending request is still there for the real link, which signs in the right address.
    expect(await completeSignInFromLink({ kind: 'token_hash', tokenHash: 'h4sh', type: 'magiclink' })).toEqual({ ok: true });
  });
});
