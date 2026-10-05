/**
 * Expo push sender for the API routes and jobs (plan §4 integrations "Expo push (expo-server-sdk)", §23.H "push
 * batches (100 per request) go first", §11 pushReceipts "drop invalid tokens"). sendPush() drops messages whose token
 * is not an Expo push token, sends the rest PUSH_CHUNK at a time and returns exactly one ticket per input message,
 * in input order; a failed request becomes error tickets for that chunk rather than a throw, so a status change
 * never fails because Expo did. Tokens Expo reports as DeviceNotRegistered come back in `invalidTokens` for the
 * caller to delete. The sender is injectable: tests pass a fake, production builds an Expo client per call (workerd
 * keeps no memory between requests, plan §3.10) with EXPO_ACCESS_TOKEN when the env sets one. Server-only module.
 */
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';

import { getServerEnv } from './env';
import { logEvent } from './log';

export const PUSH_CHUNK = 100; // spec: plan §23.H "push batches (100 per request)"; Expo.pushNotificationChunkSizeLimit

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** Deep-link payload, e.g. {reportId} or {alertId} (plan §9.4). */
  data: Record<string, unknown>;
  /** Android channel (plan §9.4: rootcause-status · rootcause-alerts · rootcause-paging). */
  channelId?: string;
  priority?: 'default' | 'normal' | 'high';
}

export interface PushSender {
  /** One request to Expo for one chunk; resolves to one ticket per message in the chunk. */
  send(chunk: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
}

export interface PushResult {
  /** tickets[i] answers messages[i]. */
  tickets: ExpoPushTicket[];
  /** Messages Expo accepted (ticket status 'ok'). */
  sent: number;
  /** Tokens to delete: not an Expo token, or DeviceNotRegistered. */
  invalidTokens: string[];
}

let override: PushSender | null = null;

/** Tests inject a fake sender; null restores the Expo client. */
export function setPushSender(sender: PushSender | null): void {
  override = sender;
}

function expoSender(): PushSender {
  const accessToken = getServerEnv().expoAccessToken;
  const client = new Expo(accessToken ? { accessToken } : {});
  return { send: (chunk) => client.sendPushNotificationsAsync(chunk) };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toExpoMessage(m: PushMessage): ExpoPushMessage {
  return { to: m.to, title: m.title, body: m.body, data: m.data, sound: 'default', channelId: m.channelId, priority: m.priority ?? 'default' };
}

const errorTicket = (message: string, token?: string): ExpoPushTicket => ({ status: 'error', message, details: token ? { error: 'DeviceNotRegistered', expoPushToken: token } : undefined });

export async function sendPush(messages: readonly PushMessage[]): Promise<PushResult> {
  const tickets: ExpoPushTicket[] = new Array(messages.length);
  const validIndexes: number[] = [];
  messages.forEach((m, i) => {
    if (Expo.isExpoPushToken(m.to)) validIndexes.push(i);
    else tickets[i] = errorTicket('Not an Expo push token', m.to);
  });

  const sender = override ?? (validIndexes.length > 0 ? expoSender() : null);
  for (const group of chunk(validIndexes, PUSH_CHUNK)) {
    const payload = group.map((i) => toExpoMessage(messages[i]));
    let got: ExpoPushTicket[];
    try {
      got = await sender!.send(payload);
    } catch (e) {
      logEvent('warn', 'push.chunk_failed', { count: payload.length, error: e instanceof Error ? e : new Error(String(e)) });
      got = payload.map(() => errorTicket('Push request failed'));
    }
    group.forEach((i, j) => {
      tickets[i] = got[j] ?? errorTicket('No ticket returned');
    });
  }

  const invalid = new Set<string>();
  tickets.forEach((t, i) => {
    if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') invalid.add(t.details.expoPushToken ?? messages[i].to);
  });
  return { tickets, sent: tickets.filter((t) => t.status === 'ok').length, invalidTokens: [...invalid] };
}
