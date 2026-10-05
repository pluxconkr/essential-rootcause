/**
 * Synthetic JPEG bytes for tests (src/server/exif.ts, the photos route): a structurally valid file — SOI, JFIF APP0,
 * optional EXIF and XMP APP1 segments, an optional COM, DQT, SOF0 with the given size, DHT, SOS, a few bytes of
 * scan data with a stuffed 0xFF00, EOI. Nothing decodes it; it only has to walk like a JPEG. Lives outside
 * __tests__ so jest does not treat it as a test suite.
 */

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** marker + 2-byte length (payload + 2) + payload */
export function segment(marker: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload];
}

export const JFIF_APP0 = segment(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
/** "Exif\0\0" + a little-endian TIFF header + a fake GPS IFD pointer: the kind of thing a phone writes. */
export const EXIF_APP1 = segment(0xe1, [...ascii('Exif'), 0, 0, 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x25, 0x88, 4, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0]);
export const XMP_APP1 = segment(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/'), 0, ...ascii('<x:xmpmeta/>')]);
export const COMMENT = segment(0xfe, ascii('shot on a phone'));
export const SCAN_DATA = [0x12, 0x34, 0xff, 0x00, 0x56, 0x78];
export const EOI = [0xff, 0xd9];

export interface JpegOptions {
  width?: number;
  height?: number;
  exif?: boolean;
  xmp?: boolean;
  comment?: boolean;
  /** Extra 0xFF fill bytes before the SOF marker (allowed by the standard). */
  fill?: boolean;
  /** Extra scan bytes to reach a target size. */
  padBytes?: number;
}

export function syntheticJpeg(o: JpegOptions = {}): Uint8Array {
  const width = o.width ?? 640;
  const height = o.height ?? 480;
  const dqt = segment(0xdb, [0, ...new Array<number>(64).fill(1)]);
  const sof0 = segment(0xc0, [8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const dht = segment(0xc4, [0, ...new Array<number>(16).fill(0), 0]);
  const sos = segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]);
  const bytes = [
    0xff,
    0xd8,
    ...JFIF_APP0,
    ...(o.exif === false ? [] : EXIF_APP1),
    ...(o.xmp ? XMP_APP1 : []),
    ...(o.comment ? COMMENT : []),
    ...dqt,
    ...(o.fill ? [0xff, 0xff] : []),
    ...sof0,
    ...dht,
    ...sos,
    ...SCAN_DATA,
    ...new Array<number>(o.padBytes ?? 0).fill(0x5a),
    ...EOI,
  ];
  return new Uint8Array(bytes);
}

/** PNG magic — a file that is not a JPEG. */
export const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
