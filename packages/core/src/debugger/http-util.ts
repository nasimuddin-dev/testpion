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

/** Percent-decoding of text the other side sent (a path, a gRPC message): text that is not valid percent-encoding stays as it came. */
export const safeDecode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

interface RelaySource {
  pause(): unknown;
  resume(): unknown;
}
interface RelaySink {
  write(chunk: Buffer): unknown;
  on(event: 'drain' | 'close', listener: () => void): unknown;
  destroyed?: boolean;
}

/**
 * Writes the chunks of `from` to `to` and makes the source wait while the destination is full: when write() says so the source is
 * paused until 'drain'. Without it a large body going to a slow reader (a slow client, a Network speed) was queued whole in memory.
 * A destination that closed takes nothing more: the source runs on to its end, as before, and what it sends is dropped.
 * `onWait` hears when the wait starts and ends (the source's idle timeout must not count the time it was made to wait).
 */
export function relayWriter(from: RelaySource, to: RelaySink, onWait?: (waiting: boolean) => void): (chunk: Buffer) => void {
  let waiting = false;
  let closed = false;
  const go = () => {
    if (!waiting) return;
    waiting = false;
    onWait?.(false);
    from.resume();
  };
  to.on('drain', go);
  to.on('close', () => {
    closed = true;
    go();
  });
  return (chunk) => {
    if (to.write(chunk) !== false || waiting || closed || to.destroyed) return;
    waiting = true;
    from.pause();
    onWait?.(true);
  };
}

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

