/**
 * POST /api/v1/photos (plan §7, §4 flow 2, §12) — multipart `photo` (JPEG ≤ 600 KB) plus optional `thumb` (JPEG
 * ≤ 100 KB) → 201 PhotoUploadResponse {photoId, bytes, width, height}. This is the resident's first server write
 * (plan §23.A: sign-in happens before it), so it needs a session (D3) and a role that may file reports, and stays
 * within UPLOAD_LIMIT per account through the DB-backed limiter (plan §3.10, 429 with Retry-After). EXIF and every
 * other APPn segment are stripped again here (the phone already re-encodes) before both objects land in the private
 * bucket at <tenant>/<photoId>/{full,thumb}.jpg and a pending report_photo row is written (report_id NULL, uploader
 * = the account, staff_only until triage). Nothing is decoded on the server; a non-JPEG body is a 400.
 * Expo Router API route: no React Native imports; handlers return a Response and never throw (withTiming).
 */
import type { Action } from '@/domain/roles';
import { requireCapability, requireUser } from '@/server/auth';
import { isJpeg, jpegDimensions, stripExif } from '@/server/exif';
import { error, json, withTiming } from '@/server/http';
import { getRateLimiter, keyFor } from '@/server/ratelimit';
import { PHOTO_LIMITS, getPhotosRepo } from '@/server/repos/photos';
import { getRepos } from '@/server/repos/types';

export const UPLOAD_LIMIT = {
  perWindow: PHOTO_LIMITS.uploadsPerHour, // spec: plan §7 POST /api/v1/photos 20/h
  windowSec: 3600,
} as const;

/** Uploading is part of filing a report: residents and up, auditors refused (spec §11, plan §12). */
export const UPLOAD_ACTION: Action = 'report';

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

/** request.formData() is typed by React Native's globals in this project (no get()); the runtime (workerd / Node) is the standard one. */
interface MultipartForm {
  get(name: string): unknown;
}

/** A JPEG part with its metadata segments removed, or null when the bytes are not a JPEG we can walk. */
function cleanJpeg(bytes: Uint8Array): Uint8Array | null {
  return isJpeg(bytes) ? stripExif(bytes) : null;
}

const handlePost = withTiming('POST /api/v1/photos', async (request) => {
  const repos = getRepos();
  const user = await requireUser(request, repos);
  if (user instanceof Response) return user;
  const denied = requireCapability(user, UPLOAD_ACTION);
  if (denied) return denied;

  let form: MultipartForm;
  try {
    form = (await request.formData()) as unknown as MultipartForm;
  } catch {
    return error(400, 'bad_request', 'Body must be multipart form data with a `photo` file.');
  }
  const photoPart = form.get('photo');
  if (!(photoPart instanceof Blob)) return error(400, 'bad_request', 'Invalid request. photo: expected a JPEG file.');
  if (photoPart.size > PHOTO_LIMITS.fullBytes) return error(400, 'bad_request', `Invalid request. photo: larger than ${kb(PHOTO_LIMITS.fullBytes)}.`);
  const thumbPart = form.get('thumb');
  if (thumbPart !== null && !(thumbPart instanceof Blob)) return error(400, 'bad_request', 'Invalid request. thumb: expected a JPEG file.');
  if (thumbPart instanceof Blob && thumbPart.size > PHOTO_LIMITS.thumbBytes) return error(400, 'bad_request', `Invalid request. thumb: larger than ${kb(PHOTO_LIMITS.thumbBytes)}.`);

  const full = cleanJpeg(new Uint8Array(await photoPart.arrayBuffer()));
  if (!full) return error(400, 'bad_request', 'Invalid request. photo: not a JPEG.');
  const dims = jpegDimensions(full);
  if (!dims) return error(400, 'bad_request', 'Invalid request. photo: not a JPEG we can read.');
  let thumb = full;
  if (thumbPart instanceof Blob) {
    const cleaned = cleanJpeg(new Uint8Array(await thumbPart.arrayBuffer()));
    if (!cleaned) return error(400, 'bad_request', 'Invalid request. thumb: not a JPEG.');
    thumb = cleaned;
  }

  const allowed = await getRateLimiter().hit(keyFor(['photos:upload', user.userId]), UPLOAD_LIMIT.perWindow, UPLOAD_LIMIT.windowSec);
  if (!allowed) return error(429, 'rate_limited', 'You have uploaded many photos this hour. Try again later.', { headers: { 'retry-after': String(UPLOAD_LIMIT.windowSec) } });

  const row = await getPhotosRepo().put({ uploaderId: user.userId, full, thumb, width: dims.width, height: dims.height, now: new Date().toISOString() });
  return json({ photoId: row.id, bytes: row.bytes, width: row.width, height: row.height }, { status: 201 });
});

export async function POST(request: Request): Promise<Response> {
  return handlePost(request);
}
