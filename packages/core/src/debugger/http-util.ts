import type { ServerResponse } from 'node:http';
import type { Http2ServerResponse } from 'node:http2';

/** Small helpers of the proxy that need none of its state: HTTP/2 header rules, text detection, and holding a body whole. */
/** Headers HTTP/2 forbids (connection-specific) and HTTP/2's pseudo-headers, which HTTP/1.1 has no place for. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'http2-settings', 'te']);
export const forH2 = (h: Record<string, string | string[] | number | undefined>) =>
  Object.fromEntries(Object.entries(h).filter(([k, v]) => v !== undefined && !HOP_BY_HOP.has(k.toLowerCase()) && !k.startsWith(':')));
export const withoutPseudo = (h: Record<string, string | string[] | number | undefined>) =>
  Object.fromEntries(Object.entries(h).filter(([k, v]) => v !== undefined && !k.startsWith(':'))) as Record<string, string | string[]>;
export const forH2Out = (h: Record<string, string | string[] | number | undefined>) => forH2(h) as Record<string, string | string[]>;
/** The HTTP/2 compatibility response has the same methods as ServerResponse; it is handled as one and told apart here. */
export const isH2 = (res: ServerResponse): boolean => 'stream' in res && !!(res as unknown as Http2ServerResponse).stream;
export const textLike = (ct: string | undefined) => !ct || /json|text|xml|javascript|html|form|yaml|graphql|csv|urlencoded/i.test(ct);

/**
 * The most a request or response body is held in memory so that rules and breakpoints can change it. A body over it is not held:
 * what has arrived is sent on and the rest follows as it comes (rules that change the body, and body breakpoints, do not apply to it).
 */
export const HOLD_LIMIT = 64 * 1024 * 1024;

/**
 * A body whole (it is forwarded after the rules, which may change it), as the bytes it has: no text conversion. Over `limit` the
 * stream is paused with what has arrived so far, for the caller to send on (`over`).
 */
export const holdBody = (stream: NodeJS.ReadableStream, limit = HOLD_LIMIT) =>
  new Promise<{ body: Buffer; over?: false } | { chunks: Buffer[]; bytes: number; over: true }>((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const settle = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onEnd);
    };
    const onData = (c: Buffer) => {
      chunks.push(c);
      bytes += c.length;
      if (bytes > limit) {
        settle();
        stream.pause();
        resolve({ chunks, bytes, over: true });
      }
    };
    const onEnd = () => {
      settle();
      resolve({ body: Buffer.concat(chunks, bytes) });
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onEnd);
  });

