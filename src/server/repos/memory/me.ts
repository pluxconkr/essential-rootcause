/**
 * In-memory MeRepo for the /api/v1/me route tests (plan §14): the semantic oracle for supabase/migrations/0002_me.sql
 * deidentify_user() and the Supabase repo. Base user columns come from the bundle's MemoryUsersRepo; everything else
 * (profile extras, watch areas, devices, votes, follows, comments) lives here, and orphan_vote_weight is kept per
 * report id because ReportRow (M0 contract) does not carry the column. Deterministic ids (wa_000001…). Server-only module.
 */
import type { DeviceInput, MePatch, WatchArea, WatchAreaInput } from '@/domain/types';

import { RESOLVED_STATUSES, type DeidentifyResult, type MeExportData, type MeRepo, type MeRow, type MeStats, type PhoneRow } from '../me';
import type { ReportRow } from '../types';
import type { MemoryRepos } from './index';

/** Profile columns beyond the users repo. phone_e164 is the stored number (plan §6); MeRow only ever carries its last four digits. */
export type MeExtras = Pick<MeRow, 'email' | 'phone_verified_at' | 'sms_opt_in' | 'quiet_hours' | 'apple_refresh_token' | 'deleted_at'> & { phone_e164: string | null };

export interface MemoryVote {
  report_id: string;
  user_id: string;
  weight: number;
  created_at: string;
}

export interface MemoryComment {
  id: string;
  report_id: string;
  user_id: string | null;
  body: string;
  created_at: string;
}

export interface MemoryDevice {
  user_id: string;
  expo_push_token: string;
  platform: DeviceInput['platform'];
  install_id: string;
  last_seen_at: string;
}

const DEFAULT_EXTRAS: MeExtras = { email: null, phone_e164: null, phone_verified_at: null, sms_opt_in: false, quiet_hours: null, apple_refresh_token: null, deleted_at: null };

const byNewest = (a: ReportRow, b: ReportRow) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);

export class MemoryMeRepo implements MeRepo {
  readonly extras = new Map<string, MeExtras>();
  readonly watchAreas: (WatchArea & { user_id: string })[] = [];
  readonly devices: MemoryDevice[] = [];
  readonly votes: MemoryVote[] = [];
  readonly follows: { report_id: string; user_id: string }[] = [];
  readonly comments: MemoryComment[] = [];
  /** report.orphan_vote_weight by report id (plan §23.C). */
  readonly orphanVoteWeight = new Map<string, number>();
  /** Ids handed to deleteAuthUser(), in order. */
  readonly deletedAuthUsers: string[] = [];
  private seq = 0;

  constructor(private readonly repos: MemoryRepos) {}

  /** Tests: profile columns beyond the users repo. */
  seedExtras(userId: string, extras: Partial<MeExtras>): MeExtras {
    const row = { ...DEFAULT_EXTRAS, ...(this.extras.get(userId) ?? {}), ...extras };
    this.extras.set(userId, row);
    return { ...row };
  }

  async getMe(userId: string): Promise<MeRow | null> {
    const base = await this.repos.users.getById(userId);
    if (!base) return null;
    const { phone_e164, ...x } = this.extras.get(userId) ?? DEFAULT_EXTRAS;
    return { id: base.id, role: base.role, display_name: base.display_name, auth_provider: base.auth_provider ?? 'email', created_at: base.created_at, ...x, phone_last4: phone_e164 ? phone_e164.slice(-4) : null, quiet_hours: x.quiet_hours ? { ...x.quiet_hours } : null };
  }

  async getStats(userId: string): Promise<MeStats> {
    const mine = this.repos.reports.rows.filter((r) => r.reporter_id === userId);
    return { filed: mine.length, resolved: mine.filter((r) => RESOLVED_STATUSES.includes(r.status)).length, votes: this.votes.filter((v) => v.user_id === userId).length };
  }

  async patchMe(userId: string, patch: MePatch): Promise<void> {
    const base = await this.repos.users.getById(userId);
    if (!base) return;
    if (patch.displayName !== undefined) this.repos.users.seed({ ...base, display_name: patch.displayName?.trim() || null });
    const x = { ...DEFAULT_EXTRAS, ...(this.extras.get(userId) ?? {}) };
    if (patch.quietHours !== undefined) x.quiet_hours = patch.quietHours;
    if (patch.smsOptIn !== undefined) x.sms_opt_in = patch.smsOptIn;
    this.extras.set(userId, x);
  }

  async listWatchAreas(userId: string): Promise<WatchArea[]> {
    return this.watchAreas.filter((w) => w.user_id === userId).map(({ user_id: _u, ...w }) => ({ ...w, categories: [...w.categories] }));
  }

  async createWatchArea(userId: string, input: WatchAreaInput): Promise<WatchArea> {
    const id = `wa_${String(++this.seq).padStart(6, '0')}`;
    const row = { id, user_id: userId, ...input, categories: [...input.categories], schedule: input.schedule ? { ...input.schedule, days: [...input.schedule.days] } : null };
    this.watchAreas.push(row);
    const { user_id: _u, ...w } = row;
    return { ...w, categories: [...w.categories] };
  }

  async updateWatchArea(userId: string, id: string, input: Partial<WatchAreaInput>): Promise<WatchArea | null> {
    const i = this.watchAreas.findIndex((w) => w.id === id && w.user_id === userId);
    if (i < 0) return null;
    const defined = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<WatchAreaInput>;
    this.watchAreas[i] = { ...this.watchAreas[i], ...defined };
    const { user_id: _u, ...w } = this.watchAreas[i];
    return { ...w, categories: [...w.categories] };
  }

  async deleteWatchArea(userId: string, id: string): Promise<boolean> {
    const i = this.watchAreas.findIndex((w) => w.id === id && w.user_id === userId);
    if (i < 0) return false;
    this.watchAreas.splice(i, 1);
    return true;
  }

  async upsertDevice(userId: string, input: DeviceInput, now: string): Promise<void> {
    const row: MemoryDevice = { user_id: userId, expo_push_token: input.expoPushToken, platform: input.platform, install_id: input.installId, last_seen_at: now };
    const i = this.devices.findIndex((d) => d.expo_push_token === input.expoPushToken);
    if (i < 0) this.devices.push(row);
    else this.devices[i] = row;
  }

  async listOwnReports(userId: string, limit: number): Promise<ReportRow[]> {
    const ids = this.repos.reports.rows
      .filter((r) => r.reporter_id === userId)
      .sort(byNewest)
      .slice(0, limit)
      .map((r) => r.id);
    const rows = await Promise.all(ids.map((id) => this.repos.reports.getPublicById(id)));
    return rows.filter((r): r is ReportRow => r !== null);
  }

  async exportData(userId: string): Promise<MeExportData> {
    return {
      votes: this.votes.filter((v) => v.user_id === userId).map((v) => ({ reportId: v.report_id, at: v.created_at })),
      follows: this.follows.filter((f) => f.user_id === userId).map((f) => f.report_id),
      comments: this.comments.filter((c) => c.user_id === userId).map((c) => ({ reportId: c.report_id, body: c.body, at: c.created_at })),
      devices: this.devices.filter((d) => d.user_id === userId).map((d) => ({ platform: d.platform, lastSeenAt: d.last_seen_at })),
    };
  }

  async setAppleRefreshToken(userId: string, sealed: string | null): Promise<void> {
    this.seedExtras(userId, { apple_refresh_token: sealed });
  }

  async getPhone(userId: string): Promise<PhoneRow | null> {
    const base = await this.repos.users.getById(userId);
    const x = this.extras.get(userId);
    if (!base || !x?.phone_e164) return null;
    return { tenant_id: base.tenant_id, phone_e164: x.phone_e164, phone_verified_at: x.phone_verified_at, sms_opt_in: x.sms_opt_in };
  }

  async startPhoneVerification(userId: string, phoneE164: string): Promise<void> {
    this.seedExtras(userId, { phone_e164: phoneE164, phone_verified_at: null, sms_opt_in: false });
  }

  async setPhoneVerified(userId: string, now: string): Promise<void> {
    this.seedExtras(userId, { phone_verified_at: now });
  }

  async deidentify(userId: string, now: string): Promise<DeidentifyResult> {
    // 1. votes → orphan_vote_weight, rows removed (vote_count untouched)
    let orphan = 0;
    let votes = 0;
    for (const v of this.votes.filter((x) => x.user_id === userId)) {
      this.orphanVoteWeight.set(v.report_id, (this.orphanVoteWeight.get(v.report_id) ?? 0) + v.weight);
      orphan += v.weight;
      votes++;
    }
    this.remove(this.votes, (v) => v.user_id === userId);
    // 2. reports and photos lose the link; comments become "former user"
    let reports = 0;
    let photos = 0;
    for (const r of this.repos.reports.rows) {
      if (r.reporter_id === userId) {
        r.reporter_id = null;
        r.reporter_display = 'anonymous';
        r.reporter_display_name = null;
        reports++;
      }
      for (const p of r.photos) {
        if (p.uploader_id === userId) {
          p.uploader_id = null;
          photos++;
        }
      }
    }
    let comments = 0;
    for (const c of this.comments) {
      if (c.user_id === userId) {
        c.user_id = null;
        comments++;
      }
    }
    // 3. follows, devices, watch areas go
    const follows = this.remove(this.follows, (f) => f.user_id === userId);
    const devices = this.remove(this.devices, (d) => d.user_id === userId);
    const watchAreas = this.remove(this.watchAreas, (w) => w.user_id === userId);
    // 4. tombstone
    const base = await this.repos.users.getById(userId);
    if (base) this.repos.users.seed({ ...base, display_name: null });
    this.seedExtras(userId, { phone_e164: null, phone_verified_at: null, sms_opt_in: false, quiet_hours: null, apple_refresh_token: null, deleted_at: now });
    return { reports, photos, comments, votes, follows, devices, watchAreas, orphanVoteWeight: orphan };
  }

  async deleteAuthUser(userId: string): Promise<boolean> {
    this.deletedAuthUsers.push(userId);
    return true;
  }

  private remove<T>(list: T[], where: (x: T) => boolean): number {
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (where(list[i])) {
        list.splice(i, 1);
        n++;
      }
    }
    return n;
  }
}
