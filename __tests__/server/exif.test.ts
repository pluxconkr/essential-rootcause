/**
 * src/server/exif.ts (plan §4 flow 2 "server re-strips EXIF with a pure-JS APP1 strip"): a synthetic JPEG with
 * EXIF + XMP APP1 segments and a COM loses them and nothing else — JFIF, tables, frame header and the scan data
 * survive byte for byte, the dimensions still read, the operation is idempotent — and anything that is not a JPEG
 * we can walk (PNG, truncated, no scan) is refused rather than guessed at.
 */
import { EOI, EXIF_APP1, JFIF_APP0, PNG_HEADER, SCAN_DATA, XMP_APP1, segment, syntheticJpeg } from '../../__fixtures__/jpeg';
import { hasExif, isJpeg, jpegDimensions, jpegSegments, stripExif } from '@/server/exif';

const markers = (bytes: Uint8Array) => (jpegSegments(bytes) ?? []).map((s) => s.marker);
const tail = (bytes: Uint8Array, n: number) => Array.from(bytes.subarray(bytes.length - n));

test('recognises a JPEG, finds its APP1 segments and reads the frame size', () => {
  const jpeg = syntheticJpeg({ xmp: true, width: 1280, height: 960 });
  expect(isJpeg(jpeg)).toBe(true);
  expect(hasExif(jpeg)).toBe(true);
  expect(jpegDimensions(jpeg)).toEqual({ width: 1280, height: 960 });
  expect(markers(jpeg)).toEqual([0xd8, 0xe0, 0xe1, 0xe1, 0xdb, 0xc0, 0xc4, 0xda]);
});

test('strips EXIF, XMP and comments; keeps JFIF, tables, frame header and the scan data unchanged', () => {
  const jpeg = syntheticJpeg({ xmp: true, comment: true });
  const out = stripExif(jpeg);
  expect(out).not.toBeNull();
  expect(hasExif(out!)).toBe(false);
  expect(markers(out!)).toEqual([0xd8, 0xe0, 0xdb, 0xc0, 0xc4, 0xda]);
  expect(Array.from(out!.subarray(2, 2 + JFIF_APP0.length))).toEqual(JFIF_APP0);
  expect(tail(out!, SCAN_DATA.length + EOI.length)).toEqual([...SCAN_DATA, ...EOI]);
  expect(out!.length).toBe(jpeg.length - EXIF_APP1.length - XMP_APP1.length - segment(0xfe, Array.from('shot on a phone', (c) => c.charCodeAt(0))).length);
  expect(jpegDimensions(out!)).toEqual({ width: 640, height: 480 });
  // Idempotent: a clean file comes back identical.
  expect(Array.from(stripExif(out!)!)).toEqual(Array.from(out!));
  // The input was not touched.
  expect(hasExif(jpeg)).toBe(true);
});

test('a file without metadata is returned byte for byte, fill bytes before a marker are tolerated', () => {
  const clean = syntheticJpeg({ exif: false, fill: true });
  expect(hasExif(clean)).toBe(false);
  expect(Array.from(stripExif(clean)!)).toEqual(Array.from(clean));
  expect(jpegDimensions(clean)).toEqual({ width: 640, height: 480 });
});

test('refuses what it cannot walk: PNG, empty, truncated before the scan, EOI without a scan, a bad segment length', () => {
  expect(isJpeg(PNG_HEADER)).toBe(false);
  expect(stripExif(PNG_HEADER)).toBeNull();
  expect(jpegDimensions(PNG_HEADER)).toBeNull();
  expect(stripExif(new Uint8Array())).toBeNull();
  const jpeg = syntheticJpeg();
  const cut = jpeg.subarray(0, 2 + JFIF_APP0.length + 10);
  expect(stripExif(cut)).toBeNull();
  expect(jpegDimensions(cut)).toBeNull();
  expect(stripExif(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  expect(stripExif(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01]))).toBeNull();
  // Garbage where a marker should be.
  expect(stripExif(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0x00, 0x01]))).toBeNull();
});
