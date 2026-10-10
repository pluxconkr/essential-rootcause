/**
 * JPEG metadata stripping (plan §4 flow 2 "server re-strips EXIF with a pure-JS APP1 strip", §12 "EXIF stripped on
 * device and server"). Pure JavaScript over a Uint8Array — no image library, nothing decoded: the file is walked
 * marker by marker up to the start of scan (SOS) and every application segment except APP0 (JFIF) is dropped, as are
 * COM segments; the entropy-coded image data that follows SOS is copied byte for byte. EXIF, XMP, ICC profiles,
 * Photoshop/IPTC blocks and GPS all live in those APPn segments, so a stripped file carries none of them.
 * `jpegDimensions()` reads the frame header (SOF) for the width/height the upload response reports.
 * Server-only module; works on workerd and Node (no Buffer).
 */

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP15 = 0xef;
const COM = 0xfe;
/** Standalone markers with no length field: TEM, RST0–RST7, SOI, EOI. */
const STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, SOI, EOI]);
/** Frame headers SOF0–SOF15 minus DHT (C4), JPG (C8) and DAC (CC). */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export interface JpegSegment {
  /** The marker byte after 0xFF (0xE1 for APP1 …). */
  marker: number;
  /** Offset of the 0xFF that starts the marker. */
  start: number;
  /** Offset one past the segment's last byte (payload included). */
  end: number;
}

/** True for a byte sequence that starts like a JPEG file (SOI then another marker). */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === SOI && bytes[2] === 0xff;
}

/**
 * Header segments from SOI up to and including SOS, in file order. Returns null when the structure is not a JPEG
 * we can walk (missing SOI, truncated length, no SOS) — the caller treats that as "not a valid JPEG".
 */
export function jpegSegments(bytes: Uint8Array): JpegSegment[] | null {
  if (!isJpeg(bytes)) return null;
  const out: JpegSegment[] = [{ marker: SOI, start: 0, end: 2 }];
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    // Fill bytes: any number of 0xFF may precede a marker. They belong to the segment so a clean file is copied byte for byte.
    const start = i;
    while (i < bytes.length && bytes[i] === 0xff) i++;
    if (i >= bytes.length) return null;
    const marker = bytes[i];
    if (STANDALONE.has(marker)) {
      out.push({ marker, start, end: i + 1 });
      i += 1;
      if (marker === EOI) return null; // EOI before any scan: no image data
      continue;
    }
    if (i + 2 >= bytes.length) return null;
    const length = (bytes[i + 1] << 8) | bytes[i + 2];
    if (length < 2) return null;
    const end = i + 1 + length;
    if (end > bytes.length) return null;
    out.push({ marker, start, end });
    if (marker === SOS) return out;
    i = end;
  }
  return null;
}

/** Any APP1 segment present (EXIF or XMP). */
export function hasExif(bytes: Uint8Array): boolean {
  return (jpegSegments(bytes) ?? []).some((s) => s.marker === 0xe1);
}

/** Width and height from the frame header, or null when the file is not a JPEG we can read. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const segments = jpegSegments(bytes);
  if (!segments) return null;
  const sof = segments.find((s) => SOF.has(s.marker));
  if (!sof || sof.end - sof.start < 9) return null;
  // The segment may start with fill bytes (0xFF…) before the marker byte: find the marker first, then
  // marker(1) length(2) precision(1) height(2) width(2).
  let m = sof.start;
  while (m < sof.end && bytes[m] === 0xff) m++;
  if (sof.end - m < 8) return null;
  const p = m + 4;
  const height = (bytes[p] << 8) | bytes[p + 1];
  const width = (bytes[p + 2] << 8) | bytes[p + 3];
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * A copy of the file without APP1–APP15 and COM segments. APP0 (JFIF) and every table/frame segment are kept; the
 * scan data after SOS is copied unchanged. Returns null when the input is not a JPEG we can walk. Idempotent.
 */
export function stripExif(bytes: Uint8Array): Uint8Array | null {
  const segments = jpegSegments(bytes);
  if (!segments) return null;
  const keep = segments.filter((s) => !((s.marker > APP0 && s.marker <= APP15) || s.marker === COM));
  const sos = segments[segments.length - 1];
  const tail = bytes.subarray(sos.end);
  const headerBytes = keep.reduce((n, s) => n + (s.end - s.start), 0);
  const out = new Uint8Array(headerBytes + tail.length);
  let o = 0;
  for (const s of keep) {
    out.set(bytes.subarray(s.start, s.end), o);
    o += s.end - s.start;
  }
  out.set(tail, o);
  return out;
}
