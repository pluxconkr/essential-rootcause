/**
 * POST /api/v1/photos with the memory repos (plan §7, §12): 401 without a session · 403 auditor · 400 for a non-
 * multipart body, a missing or non-file part, a non-JPEG, an oversize photo or thumbnail · 201 stores EXIF-free
 * bytes for both objects at <tenant>/<photoId>/{full,thumb}.jpg and a pending staff_only row with the uploader ·
 * the full image stands in when no thumbnail is sent · 429 after UPLOAD_LIMIT.perWindow uploads per account, per hour.
 */
import { POST, UPLOAD_LIMIT } from '@/app/api/v1/photos+api';
import { PhotoUploadResponseSchema } from '@/domain/types';
import { setTestUser } from '@/server/auth';
import { hasExif, jpegDimensions } from '@/server/exif';
import { setLogSink } from '@/server/log';
import { MemoryRateLimiter, setRateLimiter } from '@/server/ratelimit';
import { createMemoryRepos, type MemoryRepos } from '@/server/repos/memory';
import { PHOTO_LIMITS } from '@/server/repos/photos';
import { setRepos } from '@/server/repos/types';

import { PNG_HEADER, syntheticJpeg } from '../../__fixtures__/jpeg';

const url = 'http://localhost/api/v1/photos';
const JANE = { id: 'u_jane', display_name: 'Jane Doe' };

const jpegBlob = (bytes: Uint8Array) => new Blob([bytes as BlobPart], { type: 'image/jpeg' });

function multipart(parts: Record<string, Blob | string>): Request {
  const fd = new FormData();
  for (const [name, value] of Object.entries(parts)) {
    if (typeof value === 'string') fd.append(name, value);
    else fd.append(name, value, `${name}.jpg`);
  }
  return new Request(url, { method: 'POST', body: fd });
}

const upload = (parts: Record<string, Blob | string>) => POST(multipart(parts));

let repos: MemoryRepos;
let now: number;

beforeAll(() => setLogSink(() => {}));
afterAll(() => {
  setLogSink(null);
  setRepos(null);
  setRateLimiter(null);
  setTestUser(undefined);
});

beforeEach(() => {
  repos = createMemoryRepos();
  repos.users.seed(JANE);
  setRepos(repos);
  now = Date.parse('2026-10-05T12:00:00.000Z');
  setRateLimiter(new MemoryRateLimiter(() => now));
  setTestUser({ userId: JANE.id, role: 'resident' });
});

test('401 without a session, 403 for an auditor; nothing is stored', async () => {
  setTestUser(null);
  expect((await upload({ photo: jpegBlob(syntheticJpeg()) })).status).toBe(401);
  repos.users.seed({ id: 'u_audit', role: 'auditor' });
  setTestUser({ userId: 'u_audit', role: 'auditor' });
  expect((await upload({ photo: jpegBlob(syntheticJpeg()) })).status).toBe(403);
  expect(repos.photos.rows).toHaveLength(0);
  expect(repos.photos.objects.size).toBe(0);
});

test('400 for a JSON body, a missing photo, a text part, a PNG, a broken JPEG, an oversize photo or thumbnail', async () => {
  const json = await POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  expect(json.status).toBe(400);
  expect((await json.json()).error.message).toMatch(/multipart/);
  expect((await upload({ thumb: jpegBlob(syntheticJpeg()) })).status).toBe(400);
  expect((await upload({ photo: 'file:///phone/full.jpg' })).status).toBe(400);
  const png = await upload({ photo: new Blob([PNG_HEADER as BlobPart], { type: 'image/png' }) });
  expect(png.status).toBe(400);
  expect((await png.json()).error.message).toMatch(/photo: not a JPEG/);
  expect((await upload({ photo: jpegBlob(syntheticJpeg().subarray(0, 40)) })).status).toBe(400);
  const big = await upload({ photo: jpegBlob(syntheticJpeg({ padBytes: PHOTO_LIMITS.fullBytes })) });
  expect(big.status).toBe(400);
  expect((await big.json()).error.message).toMatch(/photo: larger than 600 KB/);
  const bigThumb = await upload({ photo: jpegBlob(syntheticJpeg()), thumb: jpegBlob(syntheticJpeg({ padBytes: PHOTO_LIMITS.thumbBytes })) });
  expect(bigThumb.status).toBe(400);
  expect((await bigThumb.json()).error.message).toMatch(/thumb: larger than 100 KB/);
  expect((await upload({ photo: jpegBlob(syntheticJpeg()), thumb: new Blob([PNG_HEADER as BlobPart]) })).status).toBe(400);
  expect((await upload({ photo: jpegBlob(syntheticJpeg()), thumb: 'nope' })).status).toBe(400);
  expect(repos.photos.rows).toHaveLength(0);
});

test('201 stores both objects without EXIF and a pending staff_only row for the uploader', async () => {
  const full = syntheticJpeg({ xmp: true, width: 1280, height: 960 });
  const thumb = syntheticJpeg({ width: 320, height: 240 });
  const res = await upload({ photo: jpegBlob(full), thumb: jpegBlob(thumb) });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(PhotoUploadResponseSchema.safeParse(body).success).toBe(true);
  expect(body).toMatchObject({ photoId: 'ph_000001', width: 1280, height: 960 });
  expect(body.bytes).toBeLessThan(full.length);

  const row = repos.photos.rows[0];
  expect(row).toMatchObject({ id: 'ph_000001', report_id: null, uploader_id: JANE.id, visibility: 'staff_only', phase: 'before', width: 1280, height: 960, bytes: body.bytes, storage_key: 'pilot/ph_000001/full.jpg', thumb_key: 'pilot/ph_000001/thumb.jpg' });
  const storedFull = await repos.photos.read(row.storage_key);
  const storedThumb = await repos.photos.read(row.thumb_key);
  expect(storedFull).not.toBeNull();
  expect(hasExif(full)).toBe(true);
  expect(hasExif(storedFull!)).toBe(false);
  expect(jpegDimensions(storedFull!)).toEqual({ width: 1280, height: 960 });
  expect(storedFull!.length).toBe(body.bytes);
  expect(hasExif(storedThumb!)).toBe(false);
  expect(jpegDimensions(storedThumb!)).toEqual({ width: 320, height: 240 });
  // The response carries nothing but the four public fields.
  expect(Object.keys(body).sort()).toEqual(['bytes', 'height', 'photoId', 'width']);
});

test('without a thumbnail the full image stands in for it', async () => {
  const res = await upload({ photo: jpegBlob(syntheticJpeg()) });
  expect(res.status).toBe(201);
  const row = repos.photos.rows[0];
  expect(Array.from((await repos.photos.read(row.thumb_key))!)).toEqual(Array.from((await repos.photos.read(row.storage_key))!));
});

test('429 after UPLOAD_LIMIT.perWindow uploads in an hour, per account, with Retry-After; the window slides', async () => {
  for (let i = 0; i < UPLOAD_LIMIT.perWindow; i++) expect((await upload({ photo: jpegBlob(syntheticJpeg()) })).status).toBe(201);
  const res = await upload({ photo: jpegBlob(syntheticJpeg()) });
  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe(String(UPLOAD_LIMIT.windowSec));
  expect((await res.json()).error.code).toBe('rate_limited');
  expect(repos.photos.rows).toHaveLength(UPLOAD_LIMIT.perWindow);
  repos.users.seed({ id: 'u_other' });
  setTestUser({ userId: 'u_other', role: 'resident' });
  expect((await upload({ photo: jpegBlob(syntheticJpeg()) })).status).toBe(201);
  setTestUser({ userId: JANE.id, role: 'resident' });
  now += UPLOAD_LIMIT.windowSec * 1000 + 1;
  expect((await upload({ photo: jpegBlob(syntheticJpeg()) })).status).toBe(201);
});
