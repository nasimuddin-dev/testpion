import { sha256Hex } from './hash.js';
/**
 * Reading what an image is from its first bytes (no dependency): the type (by the content, never by the name or the
 * declared MIME), the size in pixels, and a copy of a JPEG / PNG without its metadata. Used before an image is sent to a
 * vision judge: only PNG, JPEG, GIF, WebP and BMP are allowed (an SVG can carry a script and is refused), a file whose
 * content is not the image it claims is refused, and the camera and location data of a photo (EXIF, XMP, ICC text) is
 * removed from the copy that is sent.
 */

type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp';

interface ImageInfo {
  mime: ImageMime;
  width?: number;
  height?: number;
}

/** The type of the bytes, or why they are not an image TestPion sends. */
export function sniffImage(b: Uint8Array): ImageInfo | { refused: string } {
  const head = Buffer.from(b.subarray(0, 512));
  const text = head.toString('latin1').trimStart().toLowerCase();
  if (text.startsWith('<svg') || text.startsWith('<?xml') || text.includes('<svg')) return { refused: 'SVG images are not sent (an SVG can carry a script); use PNG, JPEG, GIF, WebP or BMP' };
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ...jpegSize(buf) };
  if (b.length >= 10 && buf.toString('latin1', 0, 3) === 'GIF' && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return { mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (b.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ...webpSize(buf) };
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) return { mime: 'image/bmp', width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
  return { refused: 'the content is not a PNG, JPEG, GIF, WebP or BMP image' };
}

function jpegSize(buf: Buffer): { width?: number; height?: number } {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return {};
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc) hold the frame size
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return {};
}

function webpSize(buf: Buffer): { width?: number; height?: number } {
  const kind = buf.toString('latin1', 12, 16);
  if (kind === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L' && buf.length >= 25) {
    const v = buf.readUInt32LE(21);
    return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X' && buf.length >= 30) return { width: (buf.readUIntLE(24, 3) & 0xffffff) + 1, height: (buf.readUIntLE(27, 3) & 0xffffff) + 1 };
  return {};
}

/** A JPEG without its metadata segments (APP1 EXIF / XMP, APP13 Photoshop, COM comments); the picture itself is untouched. */
export function stripJpegMetadata(buf: Buffer): Buffer {
  const out: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1]!;
    if (marker === 0xda) break; // start of scan: the rest is image data
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    const seg = buf.subarray(i, i + 2 + len);
    // APP1 (e1) EXIF/XMP, APP13 (ed) IPTC, COM (fe) are dropped; APP0 (JFIF) and APP2 (ICC colour profile) stay
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) out.push(seg);
    i += 2 + len;
  }
  out.push(buf.subarray(i));
  return Buffer.concat(out);
}

/** A PNG without its text and EXIF chunks (tEXt, zTXt, iTXt, eXIf, tIME). */
export function stripPngMetadata(buf: Buffer): Buffer {
  const drop = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
  const out: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) break;
    if (!drop.has(type)) out.push(buf.subarray(i, end));
    i = end;
  }
  out.push(buf.subarray(i));
  return Buffer.concat(out);
}

export interface PreparedImage {
  mime: ImageMime;
  /** The bytes that are sent (metadata removed). */
  bytes: Buffer;
  /** The size of the original, which the limits apply to. */
  originalBytes: number;
  width?: number;
  height?: number;
  /** sha256 of the bytes that are sent: the cache key, the ledger and the result refer to the image by it. */
  sha256: string;
  /** Metadata was removed from the copy. */
  stripped: boolean;
}

/** Checks the bytes are an allowed image and returns the copy that is sent. */
export function prepareImage(raw: Uint8Array): PreparedImage | { refused: string } {
  const info = sniffImage(raw);
  if ('refused' in info) return info;
  let bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  let stripped = false;
  if (info.mime === 'image/jpeg') {
    const s = stripJpegMetadata(bytes);
    stripped = s.length !== bytes.length;
    bytes = s;
  } else if (info.mime === 'image/png') {
    const s = stripPngMetadata(bytes);
    stripped = s.length !== bytes.length;
    bytes = s;
  }
  return { ...info, bytes, originalBytes: raw.byteLength, sha256: sha256Hex(bytes), stripped };
}

/** Tokens an image costs a vision model, by each provider family's published rule (estimates for the "what will be sent" preview and the cost). */
export function imageTokens(kind: string, width = 1024, height = 1024): number {
  if (kind === 'gemini') return 258;
  if (kind === 'anthropic' || kind === 'bedrock') return Math.min(1600, Math.ceil((width * height) / 750));
  // OpenAI-compatible: 85 for the base, 170 per 512 px tile after the longest side is fitted to 2048 and the shortest to 768
  let w = width;
  let h = height;
  const fit = Math.min(1, 2048 / Math.max(w, h));
  w *= fit;
  h *= fit;
  const shrink = Math.min(1, 768 / Math.min(w, h));
  w *= shrink;
  h *= shrink;
  return 85 + 170 * Math.ceil(w / 512) * Math.ceil(h / 512);
}
