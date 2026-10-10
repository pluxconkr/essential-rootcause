/**
 * services/notifications.ts without a device (plan §9.4, §23.H): the inbox mirror built from a push payload, the deep
 * link a tapped push opens — /report/[id] for a status push, /alert/[id] for a predictive one ({alertId}), nothing for
 * neither — after any modal is dismissed, and the listeners: a predictive push is mirrored unread on arrival and read
 * on the tap, and both ask refreshAlerts() for the server copy that carries the briefing; a status push never does.
 * expo-router's imperative router and services/alerts are faked; the store is the real one over the in-memory kv.
 * startNotificationHandlers() only wires onPushReceived/onPushTapped to expo-notifications, which jest cannot load
 * (lazy import), so that wiring is not covered here. No network.
 */
import { alertFromPayload, onPushReceived, onPushTapped, openAlertTarget, recordAlert } from '@/services/notifications';
import { actions, getState, hydrate } from '@/store/appStore';

const mockRouter = { push: jest.fn(), canDismiss: jest.fn(() => false), dismissAll: jest.fn() };
jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
}));

const mockRefreshAlerts = jest.fn(async () => 'ok' as const);
jest.mock('@/services/alerts', () => ({ refreshAlerts: () => mockRefreshAlerts() }));

/** What alertDispatch sends for an alert (title/body from alert.body, data {kind, alertId}). */
const PREDICTIVE = { title: 'Heavy rain from 8:00 PM — 48 mm · 4 open hazards sensitive to rain', body: 'Expect standing water at George St & Bayard St after dark.', data: { kind: 'warning', alertId: 'al_000007' } };
/** What notify.ts sends for a status change (data {kind, reportId}). */
const STATUS = { title: '12 Somerset St: Confirmed by inspector', body: 'Open the report to see the timeline.', data: { kind: 'status', reportId: 'rc_000001' } };
const AT = Date.parse('2026-10-10T18:00:00.000Z');

const notification = (id: string, content: typeof PREDICTIVE | typeof STATUS) => ({ request: { identifier: id, content }, date: AT });

beforeEach(() => {
  actions.resetAll();
  hydrate();
  mockRouter.push.mockReset();
  mockRouter.canDismiss.mockReset().mockReturnValue(false);
  mockRouter.dismissAll.mockClear();
  mockRefreshAlerts.mockClear();
});

describe('alertFromPayload and recordAlert', () => {
  test('a predictive payload becomes an unread warning mirror with the alert id and no report; a status payload the reverse; no title → nothing', () => {
    const item = alertFromPayload(PREDICTIVE, { id: 'n_1', at: AT })!;
    expect(item).toEqual({ id: 'n_1', kind: 'warning', title: PREDICTIVE.title, body: PREDICTIVE.body, reportId: null, alertId: 'al_000007', at: '2026-10-10T18:00:00.000Z', read: false });
    expect(item.briefing).toBeUndefined();
    expect(alertFromPayload(STATUS, { id: 'n_2' })).toMatchObject({ kind: 'status', reportId: 'rc_000001', alertId: null });
    expect(alertFromPayload({ title: ' ', body: 'x', data: {} }, { id: 'n_3' })).toBeNull();
    recordAlert(item, false);
    recordAlert(item, true); // the later tap carries the same id: no duplicate, marked read
    expect(getState().alerts).toEqual([{ ...item, read: true }]);
  });
});

describe('openAlertTarget', () => {
  test('a status push opens its report, a predictive push its briefing by alert id, neither opens nothing', () => {
    openAlertTarget({ reportId: 'rc_000001', alertId: null });
    expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/report/[id]', params: { id: 'rc_000001' } });
    openAlertTarget({ reportId: null, alertId: 'al_000007' });
    expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/alert/[id]', params: { id: 'al_000007' } });
    openAlertTarget({ reportId: null, alertId: null });
    expect(mockRouter.push).toHaveBeenCalledTimes(2);
    expect(mockRouter.dismissAll).not.toHaveBeenCalled();
  });

  test('an open modal is dismissed first; a router that is not mounted yet does not throw', () => {
    mockRouter.canDismiss.mockReturnValue(true);
    openAlertTarget({ reportId: null, alertId: 'al_000007' });
    expect(mockRouter.dismissAll).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/alert/[id]', params: { id: 'al_000007' } });
    mockRouter.push.mockImplementationOnce(() => {
      throw new Error('no navigator');
    });
    expect(() => openAlertTarget({ reportId: 'rc_000001', alertId: null })).not.toThrow();
  });
});

describe('onPushReceived / onPushTapped', () => {
  test('a predictive push arriving in the foreground is mirrored unread and the server copy is requested; the tap marks it read, asks again and opens /alert/[id]', () => {
    onPushReceived(notification('n_1', PREDICTIVE));
    expect(getState().alerts).toMatchObject([{ id: 'n_1', alertId: 'al_000007', read: false }]);
    expect(mockRefreshAlerts).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).not.toHaveBeenCalled();

    onPushTapped({ notification: notification('n_1', PREDICTIVE) });
    expect(getState().alerts).toMatchObject([{ id: 'n_1', alertId: 'al_000007', read: true }]);
    expect(mockRefreshAlerts).toHaveBeenCalledTimes(2);
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/alert/[id]', params: { id: 'al_000007' } });
  });

  test('the tap that launched the app is the same path: read mirror, server copy requested, /alert/[id] opened', () => {
    onPushTapped({ notification: notification('n_3', PREDICTIVE) });
    expect(getState().alerts).toMatchObject([{ id: 'n_3', alertId: 'al_000007', read: true }]);
    expect(mockRefreshAlerts).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/alert/[id]', params: { id: 'al_000007' } });
  });

  test('a status push never asks for the alert list; its tap opens the report', () => {
    onPushReceived(notification('n_2', STATUS));
    onPushTapped({ notification: notification('n_2', STATUS) });
    expect(getState().alerts).toMatchObject([{ id: 'n_2', kind: 'status', reportId: 'rc_000001', read: true }]);
    expect(mockRefreshAlerts).not.toHaveBeenCalled();
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/report/[id]', params: { id: 'rc_000001' } });
  });

  test('a push without a title is ignored', () => {
    onPushReceived(notification('n_4', { ...PREDICTIVE, title: '' }));
    onPushTapped({ notification: notification('n_4', { ...PREDICTIVE, title: '' }) });
    expect(getState().alerts).toEqual([]);
    expect(mockRefreshAlerts).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});
