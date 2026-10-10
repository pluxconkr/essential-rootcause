/**
 * Intake screens S-04…S-07 offline with ZERO network (plan §14 "offline submit creates a draft; submit while signed
 * out keeps the draft"): capture without camera permission states the steps and offers the library; a library photo
 * writes a draft to disk before anything else and asks to confirm the spot, then reaches the form; the form refuses
 * an incomplete submit and says what is missing; an offline submit queues the draft and S-07 shows "Saved on this
 * phone · sends when online"; a signed-out submit parks the draft as needs_sign_in; S-07 shows score, rank and the
 * service-level deadlines for a sent draft; S-05 shows the honest offline line, the exact-upload caption and
 * duplicates. expo-camera, expo-image-picker and expo-image-manipulator are mocked; the file system is jest-expo's.
 */
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { File, Paths } from 'expo-file-system';

import AnalysisScreen from '@/app/new/analysis';
import FormScreen from '@/app/new/form';
import CaptureScreen from '@/app/new/index';
import SubmittedScreen from '@/app/new/submitted';
import { buildDemoReports } from '@/domain/demo';
import { PILOT } from '@/domain/pilot';
import type { AuthSession, Draft, PublicReport } from '@/domain/types';
import { applyDemoScenario } from '@/services/demo';
import { actions, getState, hydrate, setState } from '@/store/appStore';

jest.mock('expo-camera', () => ({
  CameraView: () => null,
  Camera: {
    getCameraPermissionsAsync: jest.fn(async () => ({ granted: false, status: 'denied', canAskAgain: false })),
    requestCameraPermissionsAsync: jest.fn(async () => ({ granted: false, status: 'denied', canAskAgain: false })),
  },
}));

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: 'file:///mock/cache/picked.jpg', width: 3024, height: 4032 }] })),
}));

jest.mock('expo-image-manipulator', () => {
  let n = 0;
  const context = () => {
    let size = { width: 3024, height: 4032 };
    const ctx = {
      resize(s: { width?: number | null; height?: number | null }) {
        size = s.width ? { width: s.width, height: Math.round(s.width * (4032 / 3024)) } : { width: Math.round((s.height ?? 0) * (3024 / 4032)), height: s.height ?? 0 };
        return ctx;
      },
      async renderAsync() {
        return {
          ...size,
          async saveAsync() {
            const fs = jest.requireActual('expo-file-system') as typeof import('expo-file-system');
            const out = new fs.File(fs.Paths.cache, `manipulated-${++n}.jpg`);
            out.write(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
            return { uri: out.uri, ...size };
          },
        };
      },
    };
    return ctx;
  };
  return { SaveFormat: { JPEG: 'jpeg' }, ImageManipulator: { manipulate: jest.fn(() => context()) } };
});

const Stub = () => null;
const routes = {
  index: Stub,
  'report/[id]': Stub,
  'new/index': CaptureScreen,
  'new/analysis': AnalysisScreen,
  'new/form': FormScreen,
  'new/submitted': SubmittedScreen,
};

const SESSION: AuthSession = { userId: 'u_jane', role: 'resident', displayName: 'Jane Doe', email: null, provider: 'apple' };
const T0 = '2026-10-05T12:00:00.000Z';
const fetchSpy = jest.spyOn(globalThis, 'fetch' as never);

function draft(id: string, over: Partial<Draft> = {}): Draft {
  return { id, photoUris: [], thumbUris: [], gps: { lat: PILOT.center.lat, lng: PILOT.center.lng, accuracyM: 8 }, locationConfirmed: true, capturedAt: T0, form: {}, status: 'draft', failReason: null, reportId: null, updatedAt: T0, ...over };
}

const COMPLETE: Draft['form'] = { category: 'vegetation', subtype: 'root_heave', severityResident: 2, injuryFlag: 'no', reporterDisplay: 'named', lat: PILOT.center.lat, lng: PILOT.center.lng, accuracyM: 8, locationConfirmed: true, note: 'Lifted panel' };

/** A saved photo on the mock file system, so the preview and the upload step have a real file. */
function savedPhoto(id: string): string {
  const f = new File(Paths.document, 'drafts', id, 'full.jpg');
  f.parentDirectory.create({ intermediates: true, idempotent: true });
  f.write(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  return f.uri;
}

/** renderRouter turns fake timers on, so a press must flush pending timers inside act() or React never commits the update. RNTL 14's fireEvent is async: it must be awaited, or its act scope is still open when the next act starts, React's act depth leaks and every later render in the process stays empty. */
async function press(el: ReturnType<typeof screen.getByText>) {
  await act(async () => {
    await fireEvent.press(el);
    jest.runOnlyPendingTimers();
  });
}

beforeEach(() => {
  hydrate();
  actions.resetAll();
  applyDemoScenario('calm');
  setState({ network: { online: false, type: 'NONE' }, locationStatus: 'denied', location: null, session: null });
  actions.savePrefs({ ...getState().prefs, home: { ...PILOT.center, radiusM: 400 } }, { finishOnboarding: true });
  fetchSpy.mockClear();
});

afterEach(() => {
  // renderRouter runs on fake timers: a navigation or retry a test left scheduled (e.g. requireSession pushing /sign-in)
  // must not fire inside the next test's fresh router.
  jest.clearAllTimers();
});

afterAll(() => fetchSpy.mockRestore());

describe('S-04 capture', () => {
  test('without camera permission: the three steps, the honest line and the library are offered; zero fetch', async () => {
    await renderRouter(routes, { initialUrl: '/new' });
    expect(await screen.findByText('Camera access is off')).toBeTruthy();
    expect(screen.getByText('1 · Photograph the hazard')).toBeTruthy();
    expect(screen.getByText(/You can still choose a photo from your library/)).toBeTruthy();
    expect(screen.getByTestId('capture-library')).toBeTruthy();
    expect(screen.queryByTestId('capture-shutter')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a library photo offline: draft on disk first, photo saved in its folder, spot confirmed from the list, then the form; zero fetch', async () => {
    await renderRouter(routes, { initialUrl: '/new' });
    await press(await screen.findByTestId('capture-library'));
    expect(await screen.findByText('Use this photo')).toBeTruthy();
    const drafts = getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: 'draft', locationConfirmed: false, gps: null });
    expect(drafts[0].photoUris[0]).toMatch(new RegExp(`/drafts/${drafts[0].id}/full\\.jpg$`));
    expect(drafts[0].thumbUris?.[0]).toMatch(/thumb\.jpg$/);
    expect(new File(drafts[0].photoUris[0]).exists).toBe(true);
    expect(screen.getByText('This is exactly the photo that will be uploaded.')).toBeTruthy();

    await press(screen.getByTestId('capture-use'));
    expect((await screen.findAllByText('Confirm where this is')).length).toBeGreaterThan(0);
    expect(screen.getByTestId('place-pilot')).toBeTruthy();
    expect(screen.getByTestId('place-home')).toBeTruthy();
    expect(screen.queryByTestId('place-gps')).toBeNull();

    await press(screen.getByTestId('place-pilot'));
    expect(await screen.findByText('Report details')).toBeTruthy();
    const confirmed = getState().drafts[0];
    expect(confirmed.locationConfirmed).toBe(true);
    expect(confirmed.gps).toMatchObject({ lat: PILOT.center.lat, lng: PILOT.center.lng });
    expect(confirmed.form).toMatchObject({ lat: PILOT.center.lat, lng: PILOT.center.lng, locationConfirmed: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('S-06 form', () => {
  test('refuses an incomplete submit and says what is missing; zero fetch', async () => {
    actions.upsertDraft(draft('d_form_000001'));
    await renderRouter(routes, { initialUrl: '/new/form?draft=d_form_000001' });
    expect(await screen.findByText('Report details')).toBeTruthy();
    await press(screen.getByTestId('form-submit'));
    expect(await screen.findByText('Pick a category and sub-type.')).toBeTruthy();
    expect(screen.getByText('Answer how dangerous it is right now.')).toBeTruthy();
    expect(getState().drafts[0].status).toBe('draft');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('picking a category shows its sub-types and the emergency band shows the 911 line; edits land on the draft', async () => {
    actions.upsertDraft(draft('d_form_000002'));
    await renderRouter(routes, { initialUrl: '/new/form?draft=d_form_000002' });
    await screen.findByText('Report details');
    await press(screen.getByText('Roadway'));
    expect(await screen.findByTestId('subtype-pothole')).toBeTruthy();
    expect(getState().drafts[0].form).toMatchObject({ category: 'roadway', subtype: 'pothole' });
    await press(screen.getByText('Emergency'));
    expect(await screen.findByText('If anyone is in danger right now, call 911.')).toBeTruthy();
    expect(getState().drafts[0].form.severityResident).toBe(4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('offline and signed in: submit queues the draft and S-07 shows the saved-on-this-phone line; zero fetch', async () => {
    setState({ session: SESSION });
    actions.upsertDraft(draft('d_form_000003', { form: COMPLETE }));
    await renderRouter(routes, { initialUrl: '/new/form?draft=d_form_000003' });
    await screen.findByText('Report details');
    await press(screen.getByTestId('form-submit'));
    expect(await screen.findByText('Saved on this phone · sends when online')).toBeTruthy();
    expect(getState().drafts[0]).toMatchObject({ status: 'queued', form: COMPLETE });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('signed out: submit keeps the draft as needs_sign_in and explains; zero fetch', async () => {
    actions.upsertDraft(draft('d_form_000004', { form: COMPLETE }));
    await renderRouter(routes, { initialUrl: '/new/form?draft=d_form_000004' });
    await screen.findByText('Report details');
    await press(screen.getByTestId('form-submit'));
    expect(await screen.findByText(/Sign in from the Me tab/)).toBeTruthy();
    expect(getState().drafts[0].status).toBe('needs_sign_in');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('save draft keeps the edits on this phone', async () => {
    actions.upsertDraft(draft('d_form_000005'));
    await renderRouter(routes, { initialUrl: '/new/form?draft=d_form_000005' });
    await screen.findByText('Report details');
    await fireEvent.changeText(screen.getByTestId('form-note'), 'Lip by the curb');
    await press(screen.getByTestId('form-save'));
    expect(getState().drafts[0]).toMatchObject({ status: 'draft', form: { note: 'Lip by the curb' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('S-07 submitted', () => {
  test('a sent draft shows the five terms, the rank computed from saved reports and the service-level deadlines', async () => {
    applyDemoScenario(null);
    const { isDemo: _demo, ...base } = buildDemoReports('calm', PILOT.center)[0];
    const created: PublicReport = { ...base, id: 'rc_000001', category: 'vegetation', subtype: 'root_heave', status: 'new', severity: 2, score: 42, voteCount: 1, createdAt: T0 };
    actions.setFeed([created, { ...base, id: 'rc_000002', category: 'vegetation', status: 'new', score: 70 }, { ...base, id: 'rc_000003', category: 'roadway', status: 'new', score: 90 }]);
    actions.upsertDraft(draft('d_sent_000001', { form: COMPLETE, status: 'sent', reportId: 'rc_000001' }));
    await renderRouter(routes, { initialUrl: '/new/submitted?draft=d_sent_000001' });
    expect(await screen.findByText('Work order created')).toBeTruthy();
    expect(screen.getByText('Community votes')).toBeTruthy();
    expect(screen.getByTestId('submitted-rank').props.children).toBe('Ranks 2 of 2 open orders in this category');
    expect(screen.getByText('Permanent fix')).toBeTruthy();
    // Band 2: acknowledge, assess and fix carry deadlines; mitigation has none (domain/sla SLA_CONFIG).
    expect(screen.getAllByText(/^by /)).toHaveLength(3);
    expect(screen.getByText('No deadline for this band')).toBeTruthy();
    expect(screen.getByText('Share with neighbours')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a queued draft shows the saved-on-this-phone line; a failed one shows the reason', async () => {
    actions.upsertDraft(draft('d_q_000001', { form: COMPLETE, status: 'queued' }));
    await renderRouter(routes, { initialUrl: '/new/submitted?draft=d_q_000001' });
    expect(await screen.findByText('Saved on this phone · sends when online')).toBeTruthy();
    actions.upsertDraft(draft('d_f_000001', { form: COMPLETE, status: 'failed', failReason: 'Sub-type does not match the category.' }));
    await renderRouter(routes, { initialUrl: '/new/submitted?draft=d_f_000001' });
    expect(await screen.findByText(/Not sent: Sub-type does not match/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('S-05 analysis', () => {
  test('offline without a result: the honest line, the exact-upload caption, and Continue reaches the form', async () => {
    const id = 'd_an_000001';
    actions.upsertDraft(draft(id, { photoUris: [savedPhoto(id)] }));
    await renderRouter(routes, { initialUrl: `/new/analysis?draft=${id}` });
    expect(await screen.findByText("No signal when the photo was taken, so there was no analysis. Pick a category on the next step and file as usual.")).toBeTruthy();
    expect(screen.getByText('This is exactly the photo that will be uploaded.')).toBeTruthy();
    await press(screen.getByTestId('analysis-continue'));
    expect(await screen.findByText('Report details')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a stored result with the model off lists duplicates and offers "Add to that report"', async () => {
    const id = 'd_an_000002';
    actions.upsertDraft(
      draft(id, {
        photoUris: [savedPhoto(id)],
        photoIds: ['ph_000001'],
        analysis: { proposals: null, reason: 'disabled', model: null, duplicates: [{ id: 'rc_000009', title: 'Pothole', subtype: 'pothole', status: 'triaged', voteCount: 7, distanceM: 12.3, daysOpen: 4 }] },
      }),
    );
    await renderRouter(routes, { initialUrl: `/new/analysis?draft=${id}` });
    expect(await screen.findByText('Photo analysis is off right now. Pick a category on the next step.')).toBeTruthy();
    expect(screen.getByText('Possible duplicates within 25 m')).toBeTruthy();
    expect(screen.getByText('Pothole')).toBeTruthy();
    expect(screen.getByText(/12 m away · 4 days open · 7 votes · Confirmed by inspector/)).toBeTruthy();
    expect(screen.getByText('Add to that report')).toBeTruthy();
    expect(screen.getByText('File separately')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
