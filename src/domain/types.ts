/**
 * Shared types and zod schemas. Pure module: no React Native or Expo imports — used by the app,
 * the API routes (request validation) and the tests. Server-only shapes live in src/server.
 */
import { z } from 'zod';

import { CATEGORIES, STORM_SENSITIVITIES, SUBTYPE_IDS, type Category, type Subtype } from './taxonomy';

export type { Category, Subtype };

// ---------- Enumerations (mirrored by the SQL enums in supabase/migrations) ----------

/** Status machine (spec status-mapping table). `in progress` is an event, not a status. */
export const REPORT_STATUSES = ['new', 'triaged', 'assessed', 'mitigated', 'scheduled', 'completed', 'verified', 'rejected'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const SEVERITY_BANDS = [1, 2, 3, 4] as const;
export type SeverityBand = (typeof SEVERITY_BANDS)[number];

export const REPORTER_DISPLAYS = ['named', 'initials', 'anonymous'] as const;
export type ReporterDisplay = (typeof REPORTER_DISPLAYS)[number];

export const INJURY_FLAGS = ['no', 'near_miss', 'injury'] as const;
export type InjuryFlag = (typeof INJURY_FLAGS)[number];

export const ROLES = ['resident', 'steward', 'inspector', 'supervisor', 'director', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

export const PHOTO_PHASES = ['before', 'after'] as const;
export type PhotoPhase = (typeof PHOTO_PHASES)[number];

export const SLA_STATES = ['on_track', 'at_risk', 'breached'] as const;
export type SlaState = (typeof SLA_STATES)[number];

// ---------- Score ----------

export interface ScoreTerms {
  severity: number;
  exposure: number;
  community: number;
  liability: number;
  decay: number;
}

export interface ScoreWeights {
  severity: number;
  exposure: number;
  community: number;
  liability: number;
  decay: number;
}

export const ScoreTermsSchema = z.object({
  severity: z.number().min(0).max(1),
  exposure: z.number().min(0).max(1),
  community: z.number().min(0).max(1),
  liability: z.number().min(0).max(1),
  decay: z.number().min(0).max(1),
});

// ---------- Public report (what the phone and the public web see) ----------

const SeverityBandSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

export const ReportPhotoSchema = z.object({
  id: z.string(),
  url: z.string(),
  thumbUrl: z.string(),
  phase: z.enum(PHOTO_PHASES),
});
export type ReportPhoto = z.infer<typeof ReportPhotoSchema>;

export const ReportEventSchema = z.object({
  id: z.string(),
  kind: z.string(),
  fromStatus: z.enum(REPORT_STATUSES).nullable(),
  toStatus: z.enum(REPORT_STATUSES).nullable(),
  note: z.string().nullable(),
  at: z.string(),
});
export type ReportEvent = z.infer<typeof ReportEventSchema>;

export const PublicReportSchema = z.object({
  id: z.string(),
  category: z.enum(CATEGORIES),
  subtype: z.enum(SUBTYPE_IDS),
  status: z.enum(REPORT_STATUSES),
  title: z.string(),
  addressText: z.string(),
  addressConfidence: z.enum(['exact', 'approx']),
  /** Public point: jittered for reporter-linked reports, precise for anonymous ones until day 30 (spec §12/§13). */
  lat: z.number(),
  lng: z.number(),
  severity: SeverityBandSchema,
  severityConfirmed: z.boolean(),
  emergencyRequested: z.boolean(),
  score: z.number(),
  scoreTerms: ScoreTermsSchema,
  stormMultiplier: z.number(),
  voteCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  reporterDisplay: z.enum(REPORTER_DISPLAYS),
  reporterName: z.string().nullable(),
  stormSensitivity: z.array(z.enum(STORM_SENSITIVITIES)),
  photos: z.array(ReportPhotoSchema),
  timeline: z.array(ReportEventSchema),
  commentCount: z.number().int(),
  slaState: z.enum(SLA_STATES).optional(),
  /** Set only by demo scenarios; labelled wherever it appears. */
  isDemo: z.boolean().optional(),
});
export type PublicReport = z.infer<typeof PublicReportSchema>;

export const PublicReportListSchema = z.object({
  reports: z.array(PublicReportSchema),
  nextCursor: z.string().nullable(),
});

// ---------- Write payloads (validated identically on the phone and the server) ----------

export const CreateReportInputSchema = z.object({
  clientDraftId: z.string().min(8).max(64),
  category: z.enum(CATEGORIES),
  subtype: z.enum(SUBTYPE_IDS),
  /** The resident's "how dangerous right now?" answer: 1 Annoying · 2 Risky · 3 Someone will fall · 4 Emergency. */
  severityResident: SeverityBandSchema,
  injuryFlag: z.enum(INJURY_FLAGS),
  reporterDisplay: z.enum(REPORTER_DISPLAYS),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative().nullable(),
  /** Library photos carry no GPS, so the resident confirms the spot on the map (plan §9.1). */
  locationConfirmed: z.boolean(),
  addressText: z.string().max(200).optional(),
  note: z.string().max(1000).optional(),
  photoIds: z.array(z.string()).max(4),
  capturedAt: z.string(),
});
export type CreateReportInput = z.infer<typeof CreateReportInputSchema>;

export const VoteInputSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});
export type VoteInput = z.infer<typeof VoteInputSchema>;

export const CommentInputSchema = z.object({
  body: z.string().min(1).max(1000),
  isInternal: z.boolean().optional(),
});

export const VerifyInputSchema = z.object({
  verdict: z.enum(['confirmed', 'rejected']),
  photoId: z.string().optional(),
});

// ---------- Local-only state (phone) ----------

export type DraftStatus = 'draft' | 'queued' | 'uploading' | 'sent' | 'failed' | 'needs_sign_in';

export interface Draft {
  id: string;
  photoUris: string[];
  gps: { lat: number; lng: number; accuracyM: number | null } | null;
  locationConfirmed: boolean;
  capturedAt: string;
  form: Partial<Omit<CreateReportInput, 'clientDraftId' | 'photoIds' | 'capturedAt'>>;
  status: DraftStatus;
  failReason: string | null;
  /** Set when the server accepted the draft. */
  reportId: string | null;
  updatedAt: string;
}

export type DemoScenario = 'calm' | 'storm' | 'verify';

export interface Prefs {
  /** Home area chosen in onboarding. Stays on the phone unless saved as a watch area. */
  home: { lat: number; lng: number; radiusM: number } | null;
  categories: Category[];
  quietHours: { start: string; end: string } | null;
  updatedAt: string;
}

export interface Settings {
  simulateOffline: boolean;
  demoScenario: DemoScenario | null;
  demoClockOffsetMs: number;
  visionAssist: boolean;
}

export interface AuthSession {
  userId: string;
  role: Role;
  displayName: string | null;
  email: string | null;
  provider: 'apple' | 'google' | 'email';
}

export type AssetKey = 'feed' | 'alerts';

export interface CacheMeta {
  key: AssetKey;
  fetchedAt: string;
  source: 'network' | 'demo';
  bytes: number;
  version: string;
}
export type CacheMetaMap = Partial<Record<AssetKey, CacheMeta>>;

export type DroppedItem = 'feed-cache' | 'alerts-cache' | 'sent-draft-photos';

export interface StorageNotice {
  at: string;
  dropped: DroppedItem[];
  freeBytes: number | null;
  recovered: boolean;
}

export interface LocationFix {
  lat: number;
  lng: number;
  accuracyM: number | null;
  at: number;
}

export type AlertKind = 'status' | 'advisory' | 'warning' | 'emergency';

export interface AlertItem {
  id: string;
  kind: AlertKind;
  title: string;
  body: string;
  reportId: string | null;
  alertId: string | null;
  at: string;
  read: boolean;
  isDemo?: boolean;
}
