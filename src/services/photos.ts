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
  new File(uri).moveSync(dest);
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
/**
 * The bytes of one of the draft's own files (expo-file-system File). Empty when the file cannot be read, so the
 * upload fails at the server with a clear 400 instead of a thrown error on the phone.
 */
async function readBytes(uri: string): Promise<Uint8Array> {
  try {
    const buffer = await new File(uri).arrayBuffer();
    return buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array();
  } catch {
    return new Uint8Array();
  }
}

/**
 * A multipart/form-data body built by hand. React Native's FormData with `{uri}` file parts fails with "Network request
 * failed" in Expo Go and development builds (seen on the simulator, 2026-10-10) and expo/fetch refuses `uri` parts, so
 * the two JPEGs are read with expo-file-system and framed here; RN's fetch sends a Uint8Array body as base64 over the
 * bridge, which is fine for ≤ 600 KB.
 */
export function multipartBody(parts: readonly { field: string; filename: string; bytes: Uint8Array; type?: string }[]): { body: Uint8Array; contentType: string } {
  const boundary = `----rootcause-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"; filename="${part.filename}"\r\nContent-Type: ${part.type ?? 'image/jpeg'}\r\n\r\n`));
    chunks.push(part.bytes);
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Sync step 1 of 2: the draft's first photo (full + thumb) → {photoId, bytes, width, height}. */
export async function uploadPhoto(draft: Draft): Promise<ApiResult<PhotoUploadResponse>> {
  const full = draft.photoUris[0];
  if (!full) return { ok: false, status: 0, code: 'no_photo', message: 'This draft has no photo to upload.', retryAfterMs: null };
  const parts = [{ field: 'photo', filename: 'full.jpg', bytes: await readBytes(full) }];
  const thumb = draft.thumbUris?.[0];
  if (thumb) parts.push({ field: 'thumb', filename: 'thumb.jpg', bytes: await readBytes(thumb) });
  const { body, contentType } = multipartBody(parts);
  return api('/api/v1/photos', PhotoUploadResponseSchema, { method: 'POST', body, headers: { 'Content-Type': contentType }, timeoutMs: PHOTO.uploadTimeoutMs });
}

/** The model answers in 2–6 s on a cold connection (live check 2026-10-10) and the server gives up at 12 s; the phone waits a little longer than that. */
export const ANALYZE_TIMEOUT_MS = 20_000;

/** Proposals, duplicate candidates, exposure and the approximate address for an uploaded photo at the draft's point. */
export function analyzePhoto(draft: Draft, photoId: string): Promise<ApiResult<AnalyzeResponse>> {
  const lat = draft.form.lat ?? draft.gps?.lat;
  const lng = draft.form.lng ?? draft.gps?.lng;
  if (lat === undefined || lng === undefined) return Promise.resolve({ ok: false, status: 0, code: 'no_location', message: 'This draft has no location yet.', retryAfterMs: null });
  return api('/api/v1/vision/analyze', AnalyzeResponseSchema, { method: 'POST', body: { photoId, lat, lng, subtypeHint: draft.form.subtype }, timeoutMs: ANALYZE_TIMEOUT_MS });
}

export const AttachPhotoResponseSchema = z.object({ report: PublicReportSchema, voted: z.boolean() });

/** "Add to that report": attach an uploaded photo to an existing open report; counts as the account's vote (plan §4 flow 4). */
export function attachPhoto(reportId: string, photoId: string): Promise<ApiResult<{ report: PublicReport; voted: boolean }>> {
  return api(`/api/v1/reports/${encodeURIComponent(reportId)}/photos`, AttachPhotoResponseSchema, { method: 'POST', body: { photoId, phase: 'before' } });
}
