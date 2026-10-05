/**
 * Photos on the phone (spec R3/R4; plan §3.2, §4 flow 2, §9.1 S-04): the picture from the camera or the library is
 * re-encoded to ≤ 1280 px on its longest side at JPEG quality 0.7 (≈ ≤ 500 KB) plus a 320 px thumbnail, both
 * EXIF-free, and saved under Paths.document/drafts/<draftId>/ — the document directory, never the purgeable cache, so a
 * draft survives an app kill (QA T3). Upload is multipart to POST /api/v1/photos (full + thumb), analysis is
 * POST /api/v1/vision/analyze, and "Add to that report" is POST /api/v1/reports/:id/photos. Nothing here throws:
 * processing returns null, network calls return ApiResult. Native only; the web console never captures photos.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { z } from 'zod';

import { AnalyzeResponseSchema, PhotoUploadResponseSchema, PublicReportSchema, type AnalyzeResponse, type Draft, type PhotoUploadResponse, type PublicReport } from '@/domain/types';

import { api, type ApiResult } from './apiClient';
import type { SourceImage } from './camera';

export const PHOTO = {
  longestPx: 1280, // spec: plan §3.2 photos capped at 1280 px
  quality: 0.7, // spec: plan §3.2 quality 0.7 (≤ 500 KB)
  thumbPx: 320, // spec: plan §3.2 320 px thumbnail
  uploadTimeoutMs: 30_000, // a 500 KB upload on a slow cell link needs more than the 10 s API default
} as const;

export interface ProcessedPhoto {
  fullUri: string;
  thumbUri: string;
  width: number;
  height: number;
  bytes: number;
}

/** Where a draft's files live: Paths.document/drafts/<draftId>/. */
export function draftDir(draftId: string): Directory {
  return new Directory(Paths.document, 'drafts', draftId);
}

/** Longest side → `px`, the other side follows; never upscales. */
function resizeTo(source: SourceImage, px: number): { width?: number; height?: number } {
  const landscape = source.width >= source.height;
  const longest = landscape ? source.width : source.height;
  const target = longest > 0 ? Math.min(px, longest) : px;
  return landscape ? { width: target } : { height: target };
}

async function render(uri: string, size: { width?: number; height?: number }, quality: number): Promise<SourceImage> {
  const context = ImageManipulator.manipulate(uri);
  context.resize(size);
  const image = await context.renderAsync();
  const out = await image.saveAsync({ compress: quality, format: SaveFormat.JPEG });
  return { uri: out.uri, width: out.width, height: out.height };
}

/** Move the manipulator's cache file into the draft folder (document directory, so it survives a cache purge). Throws when the file system refuses. */
function persist(uri: string, dest: File): File {
  if (dest.exists) dest.delete();
  new File(uri).move(dest);
  return dest;
}

/** Full image + thumbnail for a draft, saved on this phone. Null when the picture could not be read, re-encoded or saved. */
export async function processImage(draftId: string, source: SourceImage): Promise<ProcessedPhoto | null> {
  try {
    const dir = draftDir(draftId);
    dir.create({ intermediates: true, idempotent: true });
    const full = await render(source.uri, resizeTo(source, PHOTO.longestPx), PHOTO.quality);
    const thumb = await render(source.uri, resizeTo(source, PHOTO.thumbPx), PHOTO.quality);
    const fullFile = persist(full.uri, new File(dir, 'full.jpg'));
    const thumbFile = persist(thumb.uri, new File(dir, 'thumb.jpg'));
    return { fullUri: fullFile.uri, thumbUri: thumbFile.uri, width: full.width, height: full.height, bytes: fullFile.size };
  } catch (e) {
    if (__DEV__) console.warn('[photos] process failed', e);
    return null;
  }
}

/** Delete a draft's folder (retake, discard). Never throws. */
export function removeDraftPhotos(draftId: string): void {
  try {
    const dir = draftDir(draftId);
    if (dir.exists) dir.delete();
  } catch {
    /* ignore */
  }
}

/** React Native's fetch uploads a local file from `{uri, name, type}`; the FormData type expects a Blob, hence the cast. */
function filePart(uri: string, name: string): Blob {
  return { uri, name, type: 'image/jpeg' } as unknown as Blob;
}

/** Sync step 1 of 2: the draft's first photo (full + thumb) → {photoId, bytes, width, height}. */
export function uploadPhoto(draft: Draft): Promise<ApiResult<PhotoUploadResponse>> {
  const full = draft.photoUris[0];
  if (!full) return Promise.resolve({ ok: false, status: 0, code: 'no_photo', message: 'This draft has no photo to upload.', retryAfterMs: null });
  const body = new FormData();
  body.append('photo', filePart(full, 'full.jpg'));
  const thumb = draft.thumbUris?.[0];
  if (thumb) body.append('thumb', filePart(thumb, 'thumb.jpg'));
  return api('/api/v1/photos', PhotoUploadResponseSchema, { method: 'POST', body, timeoutMs: PHOTO.uploadTimeoutMs });
}

/** Proposals (M3) and duplicate candidates for an uploaded photo at the draft's point. */
export function analyzePhoto(draft: Draft, photoId: string): Promise<ApiResult<AnalyzeResponse>> {
  const lat = draft.form.lat ?? draft.gps?.lat;
  const lng = draft.form.lng ?? draft.gps?.lng;
  if (lat === undefined || lng === undefined) return Promise.resolve({ ok: false, status: 0, code: 'no_location', message: 'This draft has no location yet.', retryAfterMs: null });
  return api('/api/v1/vision/analyze', AnalyzeResponseSchema, { method: 'POST', body: { photoId, lat, lng, subtypeHint: draft.form.subtype } });
}

export const AttachPhotoResponseSchema = z.object({ report: PublicReportSchema, voted: z.boolean() });

/** "Add to that report": attach an uploaded photo to an existing open report; counts as the account's vote (plan §4 flow 4). */
export function attachPhoto(reportId: string, photoId: string): Promise<ApiResult<{ report: PublicReport; voted: boolean }>> {
  return api(`/api/v1/reports/${encodeURIComponent(reportId)}/photos`, AttachPhotoResponseSchema, { method: 'POST', body: { photoId, phase: 'before' } });
}
