/**
 * Auth screens render from local state with ZERO network (plan §14 screens tests): the S-14 sheet shows every sign-in
 * path and settles requireSession() on "Not now"; Settings and Watch areas render offline, signed out and signed in,
 * without a fetch; the auth callback explains itself while it waits for a link. Supabase is faked as configured so the
 * sheet's controls are live; the Google SDK has no native module in Jest, which is exactly the "not available on this
 * build" path the sheet must survive.
 */
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import AuthCallbackScreen from '@/app/auth/callback';
import SettingsScreen from '@/app/settings';
import SignInScreen from '@/app/sign-in';
import WatchAreasScreen from '@/app/watch-areas';
import { PILOT } from '@/domain/pilot';
import { requireSession } from '@/services/auth';
import { actions, getState, hydrate, setState } from '@/store/appStore';

const mockAuth = {
  signInWithOtp: jest.fn(async () => ({ error: null })),
  verifyOtp: jest.fn(async () => ({ error: { message: 'Token has expired or is invalid' } })),
  signInWithIdToken: jest.fn(async () => ({ error: null })),
  signOut: jest.fn(async () => ({ error: null })),
  getSession: jest.fn(async () => ({ data: { session: null } })),
};
jest.mock('@/services/supabaseClient', () => ({
  get supabase() {
    return { auth: mockAuth };
  },
  isSignInConfigured: () => true,
  authCallbackUrl: () => 'rootcause://auth/callback',
}));

function Home() {
  return null;
}

const routes = {
  index: Home,
  'sign-in': SignInScreen,
  settings: SettingsScreen,
  'watch-areas': WatchAreasScreen,
  'auth/callback': AuthCallbackScreen,
};

const SESSION = { userId: 'u_jane', role: 'resident', displayName: 'Jane Doe', email: 'jane@example.org', provider: 'email' } as const;
const fetchSpy = jest.spyOn(globalThis, 'fetch' as never);

async function press(el: ReturnType<typeof screen.getByText>) {
  await act(async () => {
    fireEvent.press(el);
  });
}

async function type(el: ReturnType<typeof screen.getByTestId>, text: string) {
  await act(async () => {
    fireEvent.changeText(el, text);
  });
}

beforeEach(() => {
  hydrate();
  setState({ network: { online: false, type: 'NONE' }, locationStatus: 'denied', location: null, session: null });
  actions.savePrefs({ ...getState().prefs, home: { ...PILOT.center, radiusM: 400 }, quietHours: { start: '22:00', end: '07:00' } }, { finishOnboarding: true });
  fetchSpy.mockClear();
  for (const fn of Object.values(mockAuth)) fn.mockClear();
});

afterAll(() => fetchSpy.mockRestore());

describe('S-14 sign-in sheet', () => {
  test('renders the why-text and every path; Google without its SDK says so instead of failing silently', async () => {
    setState({ network: { online: true, type: 'wifi' } });
    await renderRouter(routes, { initialUrl: '/sign-in' });
    expect(await screen.findByText(/One vote per person, and your reports stay yours/)).toBeTruthy();
    if (Platform.OS === 'ios') expect(screen.getByTestId('signin-apple')).toBeTruthy();
    expect(screen.getByTestId('signin-google')).toBeTruthy();
    expect(screen.getByTestId('signin-email')).toBeTruthy();
    expect(screen.getByText('Not now')).toBeTruthy();
    await press(screen.getByTestId('signin-google'));
    expect(await screen.findByText('Sign-in did not complete. Nothing was sent.')).toBeTruthy();
    expect(screen.getByText(/Google sign-in is not available on this build/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('email path: send a code → code step → a wrong code is explained', async () => {
    setState({ network: { online: true, type: 'wifi' } });
    await renderRouter(routes, { initialUrl: '/sign-in' });
    await screen.findByTestId('signin-email');
    await type(screen.getByTestId('signin-email'), ' Jane@Example.org ');
    await press(screen.getByTestId('signin-send'));
    expect(mockAuth.signInWithOtp).toHaveBeenCalledWith({ email: 'jane@example.org', options: { shouldCreateUser: true, emailRedirectTo: 'rootcause://auth/callback' } });
    expect(await screen.findByTestId('signin-code')).toBeTruthy();
    expect(screen.getByText(/We sent a code to jane@example.org/)).toBeTruthy();
    await type(screen.getByTestId('signin-code'), '000000');
    await press(screen.getByTestId('signin-verify'));
    expect(mockAuth.verifyOtp).toHaveBeenCalledWith({ email: 'jane@example.org', token: '000000', type: 'email' });
    expect(await screen.findByText(/That code did not work/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('offline: the sheet says sign-in needs a signal and keeps its controls disabled', async () => {
    await renderRouter(routes, { initialUrl: '/sign-in?reason=staff' });
    expect(await screen.findByText(/City staff sign in with their work email/)).toBeTruthy();
    expect(screen.getByText('No signal')).toBeTruthy();
    await press(screen.getByTestId('signin-google'));
    expect(screen.queryByText('Sign-in did not complete. Nothing was sent.')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('requireSession() opens the sheet from anywhere and "Not now" resolves it with null', async () => {
    setState({ network: { online: true, type: 'wifi' } });
    await renderRouter(routes, { initialUrl: '/settings' });
    await screen.findByTestId('settings');
    let pending: Promise<unknown> | null = null;
    await act(async () => {
      pending = requireSession('vote');
    });
    expect(await screen.findByTestId('sign-in')).toBeTruthy();
    expect(screen.getByText(/One vote per person — sign in so yours counts/)).toBeTruthy();
    await press(screen.getByTestId('signin-cancel'));
    expect(await pending!).toBeNull();
    expect(await screen.findByTestId('settings')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('S-11 settings (offline, zero fetch)', () => {
  test('signed out: quiet hours save to prefs, SMS row says what it is waiting for, staff sign-in is offered', async () => {
    await renderRouter(routes, { initialUrl: '/settings' });
    expect(await screen.findByText('Alerts & preferences')).toBeTruthy();
    expect(screen.getByText(/Arrives with phone verification in the next build/)).toBeTruthy();
    expect(screen.getByTestId('settings-staff')).toBeTruthy();
    expect(screen.getByTestId('settings-sign-in')).toBeTruthy();
    await press(screen.getByText('Off'));
    expect(getState().prefs.quietHours).toBeNull();
    await press(screen.getByText('11pm–6am'));
    expect(getState().prefs.quietHours).toEqual({ start: '23:00', end: '06:00' });
    expect(screen.getByText(/Home · 400 m radius on this phone/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('signed in: identity, sign out (local scope offline) and delete my data are shown; nothing is fetched offline', async () => {
    actions.setSession(SESSION);
    await renderRouter(routes, { initialUrl: '/settings' });
    expect(await screen.findByText('Jane Doe')).toBeTruthy();
    expect(screen.getByText('jane@example.org · Email code · Resident')).toBeTruthy();
    expect(screen.getByText('Delete my data')).toBeTruthy(); // offline the cell is not pressable (no testID on a static Cell), the footer says why
    await press(screen.getByText('11pm–6am'));
    await press(screen.getByTestId('settings-sign-out'));
    expect(mockAuth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(getState().session).toBeNull();
    expect(await screen.findByTestId('settings-sign-in')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('S-11 watch areas (offline, zero fetch)', () => {
  test('signed out: the home area from setup, what signing in adds, no add button', async () => {
    await renderRouter(routes, { initialUrl: '/watch-areas' });
    expect(await screen.findByText('Sign in to save watch areas')).toBeTruthy();
    expect(screen.getByText(/400 m · from setup · not saved to an account/)).toBeTruthy();
    expect(screen.queryByTestId('watch-add')).toBeNull();
    expect(screen.getByTestId('watch-sign-in')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('signed in offline: no list fetch, the form opens with the home area and explains the radius, saving waits for a signal', async () => {
    actions.setSession(SESSION);
    await renderRouter(routes, { initialUrl: '/watch-areas' });
    expect(await screen.findByText('No signal')).toBeTruthy();
    await press(screen.getByTestId('watch-add'));
    expect(await screen.findByText('New watch area')).toBeTruthy();
    expect(screen.getByText(/400 m — about a 5-minute walk/)).toBeTruthy();
    expect(screen.getByText('Needs a signal to save')).toBeTruthy();
    await press(screen.getByLabelText('Increase'));
    expect(screen.getByText(/500 m — about a 6-minute walk/)).toBeTruthy();
    expect(screen.getByText('Vegetation')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('auth callback', () => {
  test('without a link it says what it is checking and never fetches', async () => {
    await renderRouter(routes, { initialUrl: '/auth/callback' });
    expect(await screen.findByText('Finishing sign-in')).toBeTruthy();
    expect(screen.getByText(/Checking the link from your email/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
