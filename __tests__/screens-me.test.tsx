/**
 * Me and Settings render from local state with ZERO network when offline or signed out (plan §14 screens tests;
 * spec R13 profile / impact, R14 phone + SMS opt-in): Me shows the phone's own vote count at once and the account's
 * count once GET /me answers, the median time to resolve only when an own report carries its fix, and the export
 * cell asks to sign in when signed out, says "Needs a signal" offline, and online writes the file, opens the share
 * sheet and relays the server's twice-a-day line on 429. Settings shows the Phone & SMS group in its signed-out,
 * offline, no-number, code-sent and verified states against a fake fetch; the SMS toggle appears only once the
 * number is verified and PATCHes the opt-in. Every fireEvent is awaited (RNTL 14).
 */
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import * as Sharing from 'expo-sharing';

import MeScreen, { formatDays, medianResolveDays } from '@/app/(tabs)/me';
import SettingsScreen from '@/app/settings';
import { files } from '@/data/files';
import { buildDemoReports } from '@/domain/demo';
import { PILOT } from '@/domain/pilot';
import type { AuthSession, MeProfile, PublicReport } from '@/domain/types';
import { applyDemoScenario } from '@/services/demo';
import { actions, getState, hydrate, setState } from '@/store/appStore';

jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => undefined), isAvailableAsync: jest.fn(async () => true) }));

function Stub() {
  return null;
}

const routes = { index: Stub, me: MeScreen, settings: SettingsScreen, 'sign-in': Stub, data: Stub, privacy: Stub, 'watch-areas': Stub };

const SESSION: AuthSession = { userId: 'u_jane', role: 'resident', displayName: 'Jane Doe', email: 'jane@example.org', provider: 'email' };
const T0 = '2026-10-01T12:00:00.000Z';
const EXPORTED_AT = '2026-10-05T12:00:00.000Z';

const profile = (over: Partial<MeProfile> = {}): MeProfile => ({ userId: 'u_jane', role: 'resident', displayName: 'Jane Doe', email: 'jane@example.org', provider: 'email', phoneVerified: false, phoneLast4: null, smsOptIn: false, quietHours: null, stats: { filed: 3, resolved: 1, votes: 7 }, watchAreas: [], createdAt: T0, ...over });

/** What api() reads from a Response: ok, status, statusText, headers.get, text(). */
function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return { ok: status >= 200 && status < 300, status, statusText: String(status), headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, text: async () => JSON.stringify(body) };
}

type Handler = (method: string, path: string, body: unknown) => ReturnType<typeof reply>;

const fetchSpy = jest.spyOn(globalThis, 'fetch' as never);

/** Route the phone's fetches by method + path; records every call. */
function fakeServer(handler: Handler): { calls: { method: string; path: string; body: unknown }[] } {
  const calls: { method: string; path: string; body: unknown }[] = [];
  fetchSpy.mockImplementation((async (input: unknown, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });
    return handler(method, path, body);
  }) as never);
  return { calls };
}

async function press(el: ReturnType<typeof screen.getByText>) {
  await act(async () => {
    await fireEvent.press(el);
  });
}

async function type(el: ReturnType<typeof screen.getByTestId>, text: string) {
  await act(async () => {
    await fireEvent.changeText(el, text);
  });
}

function resolvedOwnReport(daysToFix: number): PublicReport {
  const base = buildDemoReports('calm', PILOT.center)[0];
  const { isDemo: _demo, ...r } = base;
  return {
    ...r,
    id: 'rc_fixed',
    status: 'completed',
    createdAt: T0,
    timeline: [
      { id: 'e1', kind: 'created', fromStatus: null, toStatus: 'new', note: null, at: T0 },
      { id: 'e2', kind: 'status', fromStatus: 'scheduled', toStatus: 'completed', note: null, at: new Date(Date.parse(T0) + daysToFix * 86_400_000).toISOString() },
    ],
  };
}

beforeEach(() => {
  hydrate();
  applyDemoScenario('calm');
  setState({ network: { online: false, type: 'NONE' }, locationStatus: 'denied', location: null, session: null });
  actions.savePrefs({ ...getState().prefs, home: { ...PILOT.center, radiusM: 400 } }, { finishOnboarding: true });
  actions.replaceEngagement([], []);
  fetchSpy.mockReset();
  fetchSpy.mockImplementation((async () => {
    throw new Error('unexpected fetch');
  }) as never);
});

afterAll(() => fetchSpy.mockRestore());

describe('medianResolveDays', () => {
  test('median over own fixed reports with a completed event; null without one', () => {
    expect(medianResolveDays([])).toBeNull();
    expect(medianResolveDays([{ ...resolvedOwnReport(3), status: 'new' }])).toBeNull();
    expect(medianResolveDays([{ ...resolvedOwnReport(3), timeline: [] }])).toBeNull();
    expect(medianResolveDays([resolvedOwnReport(3)])).toBe(3);
    expect(medianResolveDays([resolvedOwnReport(1), resolvedOwnReport(10), { ...resolvedOwnReport(4), status: 'verified' }])).toBe(4);
    expect(medianResolveDays([resolvedOwnReport(2), resolvedOwnReport(6)])).toBe(4);
    expect(formatDays(0.4)).toBe('under a day');
    expect(formatDays(1.2)).toBe('1 day');
    expect(formatDays(3.6)).toBe('4 days');
  });
});

describe('S-10 Me (offline, zero fetch)', () => {
  test('signed out: votes counted on this phone, export asks to sign in, no median without a fixed report', async () => {
    actions.replaceEngagement(['r1', 'r2'], []);
    setState({ network: { online: true, type: 'wifi' } });
    await renderRouter(routes, { initialUrl: '/me' });
    expect(await screen.findByText('Sign in to vote and follow')).toBeTruthy();
    expect(screen.getByText('Urgency votes cast')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText(/Votes are counted on this phone/)).toBeTruthy();
    expect(screen.queryByText('Median time to resolve')).toBeNull();
    await press(screen.getByTestId('me-export'));
    expect(await screen.findByText('Sign in to export your data')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('signed in offline: the export cell says it needs a signal and nothing is fetched; the median comes from this phone’s copy', async () => {
    actions.setSession(SESSION);
    applyDemoScenario(null);
    const fixed = resolvedOwnReport(3);
    actions.setFeed([fixed]);
    actions.addMyReport({ reportId: fixed.id, draftId: 'd_fixed', anonymous: false, createdAt: T0 });
    await renderRouter(routes, { initialUrl: '/me' });
    expect(await screen.findByText('Jane Doe')).toBeTruthy();
    expect(screen.getByText('Needs a signal')).toBeTruthy();
    expect(screen.queryByTestId('me-export')).toBeNull();
    expect(screen.getByText('Median time to resolve')).toBeTruthy();
    expect(screen.getByText('3 days')).toBeTruthy();
    expect(screen.getByText(/computed on this phone’s copy/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('S-10 Me online (fake server)', () => {
  test('votes come from the account once GET /me answers; export writes the file, opens the share sheet, and relays the 429 line', async () => {
    actions.setSession(SESSION);
    setState({ network: { online: true, type: 'wifi' } });
    let exports = 0;
    const server = fakeServer((method, path) => {
      if (method === 'GET' && path === '/api/v1/me') return reply(200, profile());
      if (method === 'GET' && path === '/api/v1/me/export') {
        exports++;
        if (exports > 1) return reply(429, { error: { code: 'rate_limited', message: 'You can export your data 2 times a day. Try again tomorrow.' } }, { 'retry-after': '86400' });
        return reply(200, { format: 'rootcause-export/v1', exportedAt: EXPORTED_AT, account: { userId: 'u_jane' }, reports: [] });
      }
      return reply(404, { error: { code: 'not_found', message: 'no' } });
    });
    const share = Sharing.shareAsync as jest.Mock;
    try {
      await renderRouter(routes, { initialUrl: '/me' });
      expect(await screen.findByText('7')).toBeTruthy();
      expect(screen.getByText(/Votes are your account’s count/)).toBeTruthy();
      await press(screen.getByTestId('me-export'));
      expect(await screen.findByText('Export saved')).toBeTruthy();
      expect(screen.getByText(/Saved on this phone as rootcause-export-2026-10-05\.json/)).toBeTruthy();
      expect(server.calls.map((c) => c.path)).toEqual(['/api/v1/me', '/api/v1/me/export']);
      expect(files.readJsonSync<{ format: string }>('rootcause-export-2026-10-05.json')?.format).toBe('rootcause-export/v1');
      expect(share).toHaveBeenCalledTimes(1);
      expect(String(share.mock.calls[0][0])).toMatch(/rootcause-export-2026-10-05\.json$/);
      expect(share.mock.calls[0][1]).toMatchObject({ mimeType: 'application/json', UTI: 'public.json' });
      await press(screen.getByTestId('me-export'));
      expect(await screen.findByText('Export not ready')).toBeTruthy();
      expect(screen.getByText('You can export your data 2 times a day. Try again tomorrow.')).toBeTruthy();
    } finally {
      share.mockClear();
      files.remove('rootcause-export-2026-10-05.json');
    }
  });
});

describe('S-11 Settings — Phone & SMS', () => {
  test('signed out: asks to sign in and shows the SMS terms; nothing is fetched', async () => {
    await renderRouter(routes, { initialUrl: '/settings' });
    expect(await screen.findByText('Sign in to add a phone number')).toBeTruthy();
    expect(screen.getByText(/Reply STOP to cancel at any time; reply HELP for help/)).toBeTruthy();
    expect(screen.queryByTestId('settings-phone')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('signed in offline: needs a signal, no GET /me', async () => {
    actions.setSession(SESSION);
    await renderRouter(routes, { initialUrl: '/settings' });
    expect(await screen.findByText('Needs a signal')).toBeTruthy();
    expect(screen.queryByTestId('settings-phone')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('online: no number → send code → code sent → verify → verified; the toggle appears only then and PATCHes the opt-in', async () => {
    actions.setSession(SESSION);
    setState({ network: { online: true, type: 'wifi' } });
    let verified = false;
    let optIn = false;
    const server = fakeServer((method, path, body) => {
      if (method === 'GET' && path === '/api/v1/me') return reply(200, profile());
      if (method === 'POST' && path === '/api/v1/me/phone') return reply(200, { ok: true, last4: String((body as { phone: string }).phone).replace(/\D/g, '').slice(-4) });
      if (method === 'POST' && path === '/api/v1/me/phone/check') {
        if ((body as { code: string }).code !== '123456') return reply(400, { error: { code: 'bad_request', message: 'That code did not work. Check the digits or send a new one.' } });
        verified = true;
        return reply(200, profile({ phoneVerified: true, phoneLast4: '0100' }));
      }
      if (method === 'PATCH' && path === '/api/v1/me') {
        optIn = (body as { smsOptIn: boolean }).smsOptIn;
        return reply(200, profile({ phoneVerified: verified, phoneLast4: '0100', smsOptIn: optIn }));
      }
      return reply(404, { error: { code: 'not_found', message: 'no' } });
    });
    await renderRouter(routes, { initialUrl: '/settings' });
    expect(await screen.findByText('No phone number yet')).toBeTruthy();
    expect(screen.getByText('Verify a phone number first.')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByTestId('settings-phone-code')).toBeNull();

    // a number that is not E.164 never leaves the phone
    await type(screen.getByTestId('settings-phone'), 'call me');
    await press(screen.getByTestId('settings-phone-send'));
    expect(await screen.findByText('Check the number')).toBeTruthy();
    expect(server.calls.filter((c) => c.path === '/api/v1/me/phone')).toEqual([]);

    await type(screen.getByTestId('settings-phone'), ' +1 (732) 555-0100 ');
    await press(screen.getByTestId('settings-phone-send'));
    expect(await screen.findByText('Code sent to the number ending in 0100')).toBeTruthy();
    expect(server.calls.at(-1)).toEqual({ method: 'POST', path: '/api/v1/me/phone', body: { phone: '+17325550100' } });
    expect(screen.getByText(/Enter the 6-digit code from the text/)).toBeTruthy();

    await type(screen.getByTestId('settings-phone-code'), '000000');
    await press(screen.getByTestId('settings-phone-verify'));
    expect(await screen.findByText('Not verified')).toBeTruthy();
    expect(screen.getByText(/That code did not work/)).toBeTruthy();

    await type(screen.getByTestId('settings-phone-code'), '123456');
    await press(screen.getByTestId('settings-phone-verify'));
    expect(await screen.findByText('Verified · ends in 0100')).toBeTruthy();
    expect(screen.getByText('Number verified')).toBeTruthy();
    expect(screen.queryByTestId('settings-phone')).toBeNull();
    expect(screen.queryByTestId('settings-phone-send')).toBeNull();
    const toggle = screen.getByRole('switch');
    expect(toggle.props.accessibilityState.checked).toBe(false);

    await press(toggle);
    expect(server.calls.at(-1)).toEqual({ method: 'PATCH', path: '/api/v1/me', body: { smsOptIn: true } });
    await act(async () => {});
    expect(screen.getByRole('switch').props.accessibilityState.checked).toBe(true);
    expect(JSON.stringify(server.calls)).not.toMatch(/Authorization/);
  });

  test('online: a 429 from the server is relayed as a note, not an error state', async () => {
    actions.setSession(SESSION);
    setState({ network: { online: true, type: 'wifi' } });
    fakeServer((method, path) => {
      if (method === 'GET' && path === '/api/v1/me') return reply(200, profile({ phoneLast4: '0199' }));
      if (method === 'POST' && path === '/api/v1/me/phone') return reply(429, { error: { code: 'rate_limited', message: 'You can request 5 codes an hour. Try again later.' } }, { 'retry-after': '3600' });
      return reply(404, { error: { code: 'not_found', message: 'no' } });
    });
    await renderRouter(routes, { initialUrl: '/settings' });
    // a pending number from an earlier session: the code field is ready without a new send
    expect(await screen.findByText('Code sent to the number ending in 0199')).toBeTruthy();
    expect(screen.getByTestId('settings-phone-code')).toBeTruthy();
    await type(screen.getByTestId('settings-phone'), '+17325550199');
    await press(screen.getByTestId('settings-phone-send'));
    expect(await screen.findByText('No code sent')).toBeTruthy();
    expect(screen.getByText('You can request 5 codes an hour. Try again later.')).toBeTruthy();
  });
});
