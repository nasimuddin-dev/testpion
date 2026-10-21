import { createHash } from 'node:crypto';

/** The SHA-256 of text or bytes, as lowercase hex. */
export const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** The SHA-1 of text or bytes, as lowercase hex (a fingerprint, never a security measure). */
export const sha1Hex = (data: Buffer | string): string => createHash('sha1').update(data).digest('hex');
