/**
 * Expo push sender for the API routes and jobs (plan §4 integrations "Expo push", §23.H "push batches (100 per
 * request) go first", §11 pushReceipts "drop invalid tokens"). Talks to the Expo push HTTP API with fetch, not through
 * expo-server-sdk: the installed SDK (v7) imports node:zlib and undici, which EAS Hosting's workerd runtime does not
 * provide (plan §3.10 "SDKs that work on workerd"), and src/server never imports Expo packages (boundary test). The
 * contract is the SDK's: at most PUSH_CHUNK messages per request, one ticket per message, Bearer EXPO_ACCESS_TOKEN
 * when the env sets one. sendPush() drops messages whose token is not an Expo push token, sends the rest chunk by
 * chunk and returns exactly one ticket per input message in input order; a failed request becomes error tickets for
 * that chunk rather than a throw, so a status change never fails because Expo did. Tokens Expo reports as
 * DeviceNotRegistered come back in `invalidTokens` for the caller to delete. The sender is injectable: tests pass a
 * fake; production builds one per call (workerd keeps no memory between requests). Server-only module.
 */
import { getServerEnv } from './env';
import { logEvent } from './log';

export const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send'; // spec: Expo push API, "Send notifications" endpoint
export const PUSH_CHUNK = 100; // spec: plan §23.H "push batches (100 per request)"; the Expo API accepts at most 100 messages per request
export const PUSH_TIMEOUT_MS = 10_000; // one request must fit inside the jobs tick budget (plan §23.G: the tick returns within 20 s)

/** The Expo push API's message shape (the fields RootCause uses). */
export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound?: 'default' | null;
  channelId?: string;
  priority?: 'default' | 'normal' | 'high';
}

/** One per message, in order; `details.error` names the reason, DeviceNotRegistered meaning "delete this token". */
export type ExpoPushTicket = { status: 'ok'; id: string } | { status: 'error'; message: string; details?: { error?: string; expoPushToken?: string } };

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

/** ExponentPushToken[…] / ExpoPushToken[…], or the legacy UUID form — the same test expo-server-sdk applies. */
export function isExpoPushToken(token: unknown): token is string {
  return typeof token === 'string' && (/^Expo(nent)?PushToken\[[^\]]+\]$/.test(token) || /^[a-z\d]{8}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{12}$/i.test(token));
}

let override: PushSender | null = null;

/** Tests inject a fake sender; null restores the Expo HTTP client. */
export function setPushSender(sender: PushSender | null): void {
  override = sender;
}

/** The Expo push HTTP API: POST the chunk, read {data: tickets}; anything else is an error for the whole chunk. */
export function expoHttpSender(accessToken: string | null): PushSender {
  return {
    async send(chunkOfMessages) {
      const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
      if (accessToken) headers.authorization = `Bearer ${accessToken}`;
      const res = await fetch(EXPO_PUSH_SEND_URL, { method: 'POST', headers, body: JSON.stringify(chunkOfMessages), signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`expo push ${res.status}`);
      const body = (await res.json()) as { data?: unknown; errors?: { message?: string }[] };
      if (!Array.isArray(body.data)) throw new Error(body.errors?.[0]?.message ?? 'expo push: no tickets in the answer');
      return body.data as ExpoPushTicket[];
    },
  };
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
    if (isExpoPushToken(m.to)) validIndexes.push(i);
    else tickets[i] = errorTicket('Not an Expo push token', m.to);
  });

  const sender = override ?? (validIndexes.length > 0 ? expoHttpSender(getServerEnv().expoAccessToken) : null);
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
