/**
 * Photo storage contract for the API routes (plan §7 `POST /api/v1/photos`, §12 "private bucket, signed URLs
 * server-side", §3.4/§23.D NULL uploader on anonymous reports). A photo is two objects in the private bucket —
 * `<tenant>/<photoId>/full.jpg` and `<tenant>/<photoId>/thumb.jpg` — plus one `report_photo` row that stays
 * pending (report_id NULL) until a report attaches it; purgePhotos deletes unattached rows after 24 h (plan §11).
 * Two implementations: repos/memory/photos.ts (bytes in a Map, for route tests) and repos/supabase/photos.ts
 * (Storage upload with the service client). `getPhotosRepo()` reads the bundle that getRepos() returns, so a test
 * that injects memory repos needs no second override; the Repos interface in repos/types.ts is owned elsewhere,
 * which is why the bundles carry `photos` as an extra member rather than a declared one. Server-only module.
 */
import type { PhotoPhase } from '@/domain/types';

import { getRepos, type ReportRow, type Repos, type ReportsRepo } from './types';

/** Server-side upload caps (plan §7 "multipart ≤ 600 KB JPEG + thumbnail"; the phone targets ≤ 500 KB, plan §3.2). */
export const PHOTO_LIMITS = {
  fullBytes: 600 * 1024, // spec: plan §7 ≤ 600 KB
  thumbBytes: 100 * 1024, // a 320 px JPEG at quality 0.7 is ~20–40 KB; anything bigger is not a thumbnail
  uploadsPerHour: 20, // spec: plan §7 POST /api/v1/photos 20/h
} as const;

/** report_photo (plan §6), the columns the routes need. storage keys never leave the server. */
export interface PhotoRow {
  id: string;
  tenant_id: string;
  /** NULL while pending; set when a report attaches the photo. */
  report_id: string | null;
  /** NULL once attached to an anonymous report (plan §3.4). */
  uploader_id: string | null;
  storage_key: string;
  thumb_key: string;
  phase: PhotoPhase;
  /** staff_only until an inspector releases the photo at triage (plan §12). */
  visibility: 'staff_only' | 'public';
  width: number;
  height: number;
  bytes: number;
  created_at: string;
}

export interface PutPhotoInput {
  uploaderId: string;
  /** EXIF-stripped JPEG bytes. */
  full: Uint8Array;
  /** EXIF-stripped thumbnail; the full image stands in when the phone sent none. */
  thumb: Uint8Array;
  width: number;
  height: number;
  /** Server time as ISO; injected so the memory repo is deterministic. */
  now: string;
}

export interface AttachPhotosOpts {
  reportId: string;
  /** Anonymous report: the uploader link is removed on attach (plan §3.4, §23.D). */
  anonymous: boolean;
  phase: PhotoPhase;
}

/** A resident's correction of a vision proposal (vision_feedback, plan §3.6). `userId` is null for anonymous reports (§23.D). */
export interface VisionFeedbackInput {
  photoId: string;
  reportId: string | null;
  proposed: Record<string, unknown>;
  corrected: Record<string, unknown>;
  userId: string | null;
  modelVersion: string | null;
  now: string;
}

/** report_photo.ai_json + model_version (spec §6 "raw model output kept for audit"). */
export interface PhotoAnalysis {
  ai_json: Record<string, unknown> | null;
  model_version: string | null;
}

export interface PhotosRepo {
  /** Stores both objects and the pending row. */
  put(input: PutPhotoInput): Promise<PhotoRow>;
  get(id: string): Promise<PhotoRow | null>;
  /** Bytes of a stored object (vision, tests), null when missing. */
  read(key: string): Promise<Uint8Array | null>;
  /** Attaches the pending rows among `ids` (unknown or already attached ids are skipped); returns the rows attached. */
  attach(ids: readonly string[], opts: AttachPhotosOpts): Promise<PhotoRow[]>;
  listByReport(reportId: string): Promise<PhotoRow[]>;
  /** Keeps the model's raw answer on the photo row (spec §6). */
  setAnalysis(id: string, aiJson: Record<string, unknown>, modelVersion: string): Promise<void>;
  analysisOf(id: string): Promise<PhotoAnalysis | null>;
  /** One vision_feedback row per corrected proposal (spec 4.1 "every correction is a training label"). */
  recordFeedback(input: VisionFeedbackInput): Promise<void>;
}

export { photoKeys } from './photoKeys';

/** Bundles that also carry the photos repo (repos/memory and repos/supabase both do). */
export type ReposWithPhotos = Repos & { photos: PhotosRepo };

/** The photos repo of the active bundle (getRepos() throws ConfigError without env → the route answers 503). */
export function getPhotosRepo(): PhotosRepo {
  const repos = getRepos() as Partial<ReposWithPhotos>;
  if (!repos.photos) throw new Error('repos bundle has no photos repo');
  return repos.photos;
}

// ---------- Attaching a photo to an existing report (POST /api/v1/reports/[id]/photos, plan §4 flow 4) ----------

export interface AttachPhotoCtx {
  /** The attaching account: a resident adding evidence (phase before, counts as a vote) or an inspector's after-photo. */
  userId: string;
  phase: PhotoPhase;
  now: string;
  requestId: string;
}

export type AttachPhotoResult = { ok: true; row: ReportRow; voted: boolean } | { ok: false; reason: 'not_found' | 'closed' };

/** Implemented by both reports repos; the ReportsRepo interface itself is owned elsewhere, so the route looks it up with photoAttacher(). */
export interface PhotoAttachingReportsRepo {
  attachPhoto(reportId: string, photo: PhotoRow, ctx: AttachPhotoCtx): Promise<AttachPhotoResult>;
}

export function photoAttacher(repos: Repos): (ReportsRepo & PhotoAttachingReportsRepo) | null {
  const candidate = repos.reports as ReportsRepo & Partial<PhotoAttachingReportsRepo>;
  return typeof candidate.attachPhoto === 'function' ? (candidate as ReportsRepo & PhotoAttachingReportsRepo) : null;
}
