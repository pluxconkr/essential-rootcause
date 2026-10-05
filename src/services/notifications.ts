/**
 * Push notifications on the phone (plan §9.4: token registered via /me/devices after the first follow/vote/report;
 * channels rootcause-status and rootcause-paging; payload {reportId} deep-links; §11 channel policy row "status
 * change → push + inbox"). ensurePermissionAndRegister() asks for permission the first time an account votes, follows
 * or files (never in onboarding, spec S-00), creates the Android channels and posts the Expo token with the install id
 * to POST /api/v1/me/devices once per token+account. startNotificationHandlers() shows foreground pushes, mirrors every
 * push into the local alerts inbox (store actions.setAlerts) and opens /report/[id] when one is tapped, including the
 * tap that launched the app. expo-notifications is loaded lazily so screens never import it and the web build, where
 * everything here is a no-op, never bundles it. Nothing here throws.
 */
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { z } from 'zod';

import { kv } from '@/data/kv';
import { newId } from '@/domain/ids';
import type { AlertItem, AlertKind, DeviceInput } from '@/domain/types';
import { actions, getState } from '@/store/appStore';

import { api, installId } from './apiClient';

/** Android channels (plan §9.4). rootcause-alerts (predictive, high importance) joins in M4. */
export const CHANNELS = {
  status: { id: 'rootcause-status', name: 'Report status updates', description: 'Changes on reports you filed or follow.' },
  paging: { id: 'rootcause-paging', name: 'Staff paging', description: 'Emergency pages for on-call staff.' },
} as const;

/** kv key: the token this install last registered, so the device row is posted once per token and account. */
export const PUSH_REGISTRATION_KEY = 'push:v1';

interface PushRegistration {
  token: string;
  userId: string;
  registeredAt: string;
}

/** Whatever /api/v1/me/devices answers on 2xx is fine; only the status matters here. */
const DeviceAckSchema = z.unknown();

type NotificationsModule = typeof import('expo-notifications');
type NotificationResponse = import('expo-notifications').NotificationResponse;

async function loadNotifications(): Promise<NotificationsModule | null> {
  if (Platform.OS === 'web') return null;
  try {
    return await import('expo-notifications');
  } catch {
    return null;
  }
}

function projectId(): string | undefined {
  const fromEas = Constants.easConfig?.projectId;
  const fromExtra = (Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined)?.eas?.projectId;
  return typeof fromEas === 'string' ? fromEas : typeof fromExtra === 'string' ? fromExtra : undefined;
}

/**
 * Permission → channels → Expo token → POST /me/devices. Resolves true when this install is registered for the
 * signed-in account (already, or just now); false when signed out, denied, offline or on web. Never throws.
 */
export async function ensurePermissionAndRegister(): Promise<boolean> {
  const session = getState().session;
  if (!session) return false;
  const Notifications = await loadNotifications();
  if (!Notifications) return false;
  try {
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) return false;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNELS.status.id, { name: CHANNELS.status.name, description: CHANNELS.status.description, importance: Notifications.AndroidImportance.DEFAULT });
      await Notifications.setNotificationChannelAsync(CHANNELS.paging.id, { name: CHANNELS.paging.name, description: CHANNELS.paging.description, importance: Notifications.AndroidImportance.HIGH });
    }
    const id = projectId();
    const token = (await Notifications.getExpoPushTokenAsync(id ? { projectId: id } : undefined)).data;
    const previous = kv.get<PushRegistration>(PUSH_REGISTRATION_KEY);
    if (previous && previous.token === token && previous.userId === session.userId) return true;
    const body: DeviceInput = { expoPushToken: token, platform: Platform.OS === 'android' ? 'android' : 'ios', installId: installId() };
    const res = await api('/api/v1/me/devices', DeviceAckSchema, { method: 'POST', body });
    if (!res.ok) return false;
    kv.set(PUSH_REGISTRATION_KEY, { token, userId: session.userId, registeredAt: new Date().toISOString() } satisfies PushRegistration);
    return true;
  } catch {
    return false;
  }
}

const ALERT_KINDS: readonly AlertKind[] = ['status', 'advisory', 'warning', 'emergency'];

/** An inbox item from a push payload (server/notify.ts shape: title, body, data {kind, reportId | alertId}). Pure. */
export function alertFromPayload(content: { title?: string | null; body?: string | null; data?: Record<string, unknown> | null }, opts: { id?: string | null; at?: number } = {}): AlertItem | null {
  const title = content.title?.trim();
  if (!title) return null;
  const data = content.data ?? {};
  const reportId = typeof data.reportId === 'string' ? data.reportId : null;
  const alertId = typeof data.alertId === 'string' ? data.alertId : null;
  const kind = ALERT_KINDS.find((k) => k === data.kind) ?? (alertId ? 'advisory' : 'status');
  return { id: opts.id?.trim() || newId('n'), kind, title, body: content.body?.trim() ?? '', reportId, alertId, at: new Date(opts.at ?? Date.now()).toISOString(), read: false };
}

/** Add to the inbox once (the foreground arrival and the later tap carry the same notification id). */
export function recordAlert(item: AlertItem, read: boolean): void {
  const alerts = getState().alerts;
  if (alerts.some((a) => a.id === item.id)) {
    if (read) actions.markAlertRead(item.id);
    return;
  }
  actions.setAlerts([{ ...item, read }, ...alerts]);
}

/** The deep link a tapped push opens (plan §9.4). */
export function openAlertTarget(item: Pick<AlertItem, 'reportId'>): void {
  if (!item.reportId) return;
  try {
    router.push({ pathname: '/report/[id]', params: { id: item.reportId } });
  } catch {
    /* no navigator mounted yet; the alert is in the inbox either way */
  }
}

/** Foreground handler, received/response listeners and the cold-start tap. Returns a stop function. Web: no-op. */
export async function startNotificationHandlers(): Promise<() => void> {
  const Notifications = await loadNotifications();
  if (!Notifications) return () => {};
  try {
    Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }) });
    const onTap = (response: NotificationResponse) => {
      const { request, date } = response.notification;
      const item = alertFromPayload(request.content, { id: request.identifier, at: date });
      if (!item) return;
      recordAlert(item, true);
      openAlertTarget(item);
    };
    const received = Notifications.addNotificationReceivedListener((n) => {
      const item = alertFromPayload(n.request.content, { id: n.request.identifier, at: n.date });
      if (item) recordAlert(item, false);
    });
    const responded = Notifications.addNotificationResponseReceivedListener(onTap);
    const last = Notifications.getLastNotificationResponse();
    if (last) {
      onTap(last);
      Notifications.clearLastNotificationResponse();
    }
    return () => {
      received.remove();
      responded.remove();
    };
  } catch {
    return () => {};
  }
}
