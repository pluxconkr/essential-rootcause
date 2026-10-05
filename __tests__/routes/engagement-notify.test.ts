/**
 * server/push.ts and server/notify.ts (plan §4 flow 6, §9.4, §11 channel policy, §23.H): status pushes reach the
 * reporter and followers, skip quiet hours unless emergency, never address an anonymous reporter, name the place and
 * the new status, carry {reportId}; the sender is chunked 100 per request and never throws. Plus pointFromDb(), the
 * geography reader the Supabase engagement repo relies on for the home area.
 */
import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';

import { RESIDENT_WORDING } from '@/domain/status';
import type { CreateReportInput } from '@/domain/types';
import { setLogSink } from '@/server/log';
import { STATUS_CHANNEL, notifyStatusChange, statusChangeCopy, statusChangeRecipients } from '@/server/notify';
import { PUSH_CHUNK, chunk, sendPush, setPushSender } from '@/server/push';
import { setEngagementRepo } from '@/server/repos/engagement';
import { createMemoryRepos, type MemoryRepos } from '@/server/repos/memory';
import { MemoryEngagementRepo } from '@/server/repos/memory/engagement';
import { pointFromDb } from '@/server/repos/supabase/engagement';
import type { ReportRow } from '@/server/repos/types';

/** New York wall-clock instants (EST = UTC−5) — the same convention as __tests__/domain/time.test.ts. */
const est = (h: number) => Date.parse(`2026-01-16T${String((h + 5) % 24).padStart(2, '0')}:00:00Z`);
const token = (s: string) => `ExponentPushToken[${s}]`;

const input = (over: Partial<CreateReportInput> = {}): CreateReportInput => ({
  clientDraftId: 'd_m2k9x1a3_7f3kq',
  category: 'vegetation',
  subtype: 'root_heave',
  severityResident: 2,
  injuryFlag: 'no',
  reporterDisplay: 'named',
  lat: 40.4862,
  lng: -74.4518,
  accuracyM: 8,
  locationConfirmed: true,
  addressText: '12 Somerset St',
  photoIds: [],
  capturedAt: '2026-10-05T12:00:00.000Z',
  ...over,
});

let repos: MemoryRepos;
let engagement: MemoryEngagementRepo;
let sent: ExpoPushMessage[][];

function fakeSender(reply: (m: ExpoPushMessage) => ExpoPushTicket = (m) => ({ status: 'ok', id: `t_${String(m.to)}` })) {
  sent = [];
  setPushSender({
    async send(chunkOfMessages) {
      sent.push(chunkOfMessages);
      return chunkOfMessages.map(reply);
    },
  });
}

async function seedReport(over: Partial<CreateReportInput> = {}): Promise<ReportRow> {
  const { row } = await repos.reports.create(input(over), { userId: 'u_jane', role: 'resident', now: '2026-10-05T12:00:00.000Z', requestId: 'seed' });
  return row;
}

beforeAll(() => setLogSink(() => {}));
afterAll(() => {
  setLogSink(null);
  setEngagementRepo(null);
  setPushSender(null);
});

beforeEach(() => {
  repos = createMemoryRepos();
  repos.users.seed({ id: 'u_jane', display_name: 'Jane Doe' });
  repos.users.seed({ id: 'u_bob', display_name: 'Bob Smith' });
  repos.users.seed({ id: 'u_quiet', display_name: 'Quinn Quiet' });
  repos.users.seed({ id: 'u_nodevice', display_name: 'No Device' });
  engagement = new MemoryEngagementRepo(repos.users, repos.reports);
  engagement.seedContext('u_quiet', { quiet_hours: { start: '22:00', end: '07:00' } });
  engagement.seedDevice({ user_id: 'u_jane', expo_push_token: token('jane'), platform: 'ios' });
  engagement.seedDevice({ user_id: 'u_bob', expo_push_token: token('bob'), platform: 'android' });
  engagement.seedDevice({ user_id: 'u_quiet', expo_push_token: token('quiet'), platform: 'ios' });
  setEngagementRepo(engagement);
  fakeSender();
});

describe('sendPush', () => {
  test('chunks 100 per request and returns one ticket per message in input order', async () => {
    const messages = Array.from({ length: 250 }, (_, i) => ({ to: token(`t${i}`), title: 'T', body: 'B', data: { i } }));
    const res = await sendPush(messages);
    expect(PUSH_CHUNK).toBe(100);
    expect(sent.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(res.tickets).toHaveLength(250);
    expect(res.sent).toBe(250);
    expect(res.tickets[137]).toEqual({ status: 'ok', id: `t_${token('t137')}` });
    expect(sent[0][0]).toMatchObject({ to: token('t0'), title: 'T', body: 'B', data: { i: 0 }, sound: 'default', priority: 'default' });
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunk([], 2)).toEqual([]);
  });

  test('invalid tokens never reach Expo, DeviceNotRegistered tickets are collected, a failing request becomes error tickets', async () => {
    fakeSender((m) => (String(m.to) === token('gone') ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered', expoPushToken: String(m.to) } } : { status: 'ok', id: 'ok' }));
    const res = await sendPush([
      { to: 'not-a-token', title: 'T', body: 'B', data: {} },
      { to: token('gone'), title: 'T', body: 'B', data: {} },
      { to: token('fine'), title: 'T', body: 'B', data: {} },
    ]);
    expect(sent).toEqual([[expect.objectContaining({ to: token('gone') }), expect.objectContaining({ to: token('fine') })]]);
    expect(res.tickets.map((t) => t.status)).toEqual(['error', 'error', 'ok']);
    expect(res.sent).toBe(1);
    expect(res.invalidTokens.sort()).toEqual([token('gone'), 'not-a-token'].sort());

    setPushSender({
      async send() {
        throw new Error('expo down');
      },
    });
    const failed = await sendPush([{ to: token('a'), title: 'T', body: 'B', data: {} }]);
    expect(failed.tickets).toEqual([{ status: 'error', message: 'Push request failed', details: undefined }]);
    expect(failed.sent).toBe(0);
    expect(failed.invalidTokens).toEqual([]);
    expect((await sendPush([])).tickets).toEqual([]);
  });
});

describe('notifyStatusChange', () => {
  test('reporter + followers get a push naming the place and the new status; quiet-hours users are skipped at night', async () => {
    const row = await seedReport();
    await engagement.follow(row.id, 'u_bob', 'now');
    await engagement.follow(row.id, 'u_quiet', 'now');
    await engagement.follow(row.id, 'u_nodevice', 'now');
    expect((await statusChangeRecipients(row, engagement)).sort()).toEqual(['u_bob', 'u_jane', 'u_nodevice', 'u_quiet']);

    const res = await notifyStatusChange(row, 'scheduled', 'completed', { now: est(23) });
    expect(res).toMatchObject({ recipients: 4, quiet: 1, noDevice: 1, pushed: 2 });
    expect(res.tickets).toHaveLength(2);
    const messages = sent.flat();
    expect(messages.map((m) => String(m.to)).sort()).toEqual([token('bob'), token('jane')]);
    for (const m of messages) {
      expect(m.title).toBe(`12 Somerset St: ${RESIDENT_WORDING.completed}`);
      expect(m.body).toContain('Tree root heaving sidewalk (trip hazard) at 12 Somerset St');
      expect(m.body).toContain(`“${RESIDENT_WORDING.scheduled}” to “${RESIDENT_WORDING.completed}”`);
      expect(m.body).toMatch(/confirm the fix/);
      expect(m.data).toEqual({ kind: 'status', reportId: row.id, from: 'scheduled', to: 'completed' });
      expect(m.channelId).toBe(STATUS_CHANNEL);
      expect(m.priority).toBe('default');
      expect(JSON.stringify(m)).not.toMatch(/u_jane|u_bob|@|phone/);
    }
  });

  test('by day the quiet-hours user is included; an emergency report breaks quiet hours at night', async () => {
    const row = await seedReport();
    await engagement.follow(row.id, 'u_quiet', 'now');
    expect((await notifyStatusChange(row, 'new', 'triaged', { now: est(12) })).pushed).toBe(2);
    sent = [];
    const emergency = await seedReport({ clientDraftId: 'd_emergency_abcdef', severityResident: 4 });
    await engagement.follow(emergency.id, 'u_quiet', 'now');
    const res = await notifyStatusChange(emergency, 'new', 'mitigated', { now: est(23) });
    expect(res).toMatchObject({ recipients: 2, quiet: 0, pushed: 2 });
    expect(sent.flat().every((m) => m.priority === 'high')).toBe(true);
  });

  test('an anonymous report addresses followers only, never a reporter', async () => {
    const row = await seedReport({ reporterDisplay: 'anonymous' });
    await engagement.follow(row.id, 'u_bob', 'now');
    expect(await statusChangeRecipients(row, engagement)).toEqual(['u_bob']);
    const res = await notifyStatusChange(row, 'new', 'rejected', { now: est(12) });
    expect(res).toMatchObject({ recipients: 1, pushed: 1 });
    expect(sent.flat().map((m) => String(m.to))).toEqual([token('bob')]);
    expect(sent[0][0].body).toMatch(/who owns it/);
  });

  test('no recipients or no devices → nothing sent, nothing thrown; a sender failure is reported, not raised', async () => {
    const row = await seedReport({ reporterDisplay: 'anonymous' });
    expect(await notifyStatusChange(row, 'new', 'triaged')).toMatchObject({ recipients: 0, quiet: 0, noDevice: 0, pushed: 0, tickets: [] });
    expect(sent).toEqual([]);
    const named = await seedReport({ clientDraftId: 'd_named_abcdef' });
    setPushSender({
      async send() {
        throw new Error('expo down');
      },
    });
    const res = await notifyStatusChange(named, 'new', 'triaged', { now: est(12) });
    expect(res.pushed).toBe(0);
    expect(res.tickets.map((t) => t.status)).toEqual(['error']);
  });

  test('copy falls back to "near you" when the address is empty and names each status in resident wording', () => {
    const copy = statusChangeCopy({ subtype: 'pothole', address_text: '' }, 'new', 'scheduled');
    expect(copy.title).toBe(`near you: ${RESIDENT_WORDING.scheduled}`);
    expect(copy.body).toMatch(/scheduled window/);
  });
});

describe('pointFromDb', () => {
  function ewkbHex(lng: number, lat: number, little = true, srid = true): string {
    const buf = new ArrayBuffer(srid ? 25 : 21);
    const view = new DataView(buf);
    let off = 0;
    view.setUint8(off, little ? 1 : 0);
    off += 1;
    view.setUint32(off, srid ? 0x20000001 : 1, little);
    off += 4;
    if (srid) {
      view.setUint32(off, 4326, little);
      off += 4;
    }
    view.setFloat64(off, lng, little);
    view.setFloat64(off + 8, lat, little);
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  test('reads GeoJSON, EWKB/WKB hex in either byte order, and WKT', () => {
    expect(pointFromDb({ type: 'Point', coordinates: [-74.4518, 40.4862] })).toEqual({ lat: 40.4862, lng: -74.4518 });
    expect(pointFromDb(ewkbHex(-74.4518, 40.4862))).toEqual({ lat: 40.4862, lng: -74.4518 });
    expect(pointFromDb(ewkbHex(-74.4518, 40.4862, false, true))).toEqual({ lat: 40.4862, lng: -74.4518 });
    expect(pointFromDb(ewkbHex(-74.4518, 40.4862, true, false))).toEqual({ lat: 40.4862, lng: -74.4518 });
    expect(pointFromDb('SRID=4326;POINT(-74.4518 40.4862)')).toEqual({ lat: 40.4862, lng: -74.4518 });
    expect(pointFromDb('POINT(-74.4518 40.4862)')).toEqual({ lat: 40.4862, lng: -74.4518 });
  });

  test('anything else is null — the vote then counts as unverified_geo instead of failing', () => {
    expect(pointFromDb(null)).toBeNull();
    expect(pointFromDb(undefined)).toBeNull();
    expect(pointFromDb('')).toBeNull();
    expect(pointFromDb('not hex at all')).toBeNull();
    expect(pointFromDb('0102000020E6100000')).toBeNull(); // LineString, too short
    expect(pointFromDb({ type: 'Polygon', coordinates: [] })).toBeNull();
    expect(pointFromDb({ type: 'Point', coordinates: [200, 0] })).toBeNull();
  });
});
