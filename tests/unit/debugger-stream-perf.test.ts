import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { webSocketFrameParser, sseParser, grpcMessageReader, grpcDecompress, SseParser } from '../../packages/core/src/index.js';

const SLACK = Number(process.env.TESTPION_PERF_SLACK ?? 1);

/** An unmasked binary frame header for `len` bytes. */
const header = (len: number): Buffer => {
  const h = Buffer.alloc(10);
  h[0] = 0x82;
  h[1] = 127;
  h.writeBigUInt64BE(BigInt(len), 2);
  return h;
};

describe('stream parsers on large pieces', () => {
  it('a 50 MB WebSocket frame in 64 KB chunks is joined once (it was joined again with everything before it for every chunk)', () => {
    const len = 50 * 1024 * 1024;
    const frames: Array<{ bytes: number; opcode: string }> = [];
    const parser = webSocketFrameParser('received', (f) => frames.push(f));
    const body = Buffer.alloc(len, 7);
    const t0 = performance.now();
    parser.push(header(len));
    for (let at = 0; at < len; at += 65536) parser.push(body.subarray(at, Math.min(len, at + 65536)));
    const ms = performance.now() - t0;
    console.log(`50 MB frame in 64 KB chunks: ${ms.toFixed(0)} ms`);
    expect(frames).toEqual([expect.objectContaining({ bytes: len, opcode: 'binary' })]);
    expect(ms).toBeLessThan(1000 * SLACK);
  });

  it('frames split anywhere still come out whole, in order', () => {
    const frame = (text: string) => {
      const p = Buffer.from(text);
      return Buffer.concat([Buffer.from([0x81, p.length]), p]);
    };
    const all = Buffer.concat([frame('one'), frame('two two'), frame('three')]);
    const seen: string[] = [];
    const parser = webSocketFrameParser('sent', (f) => seen.push(f.text ?? ''));
    for (let i = 0; i < all.length; i++) parser.push(all.subarray(i, i + 1));
    expect(seen).toEqual(['one', 'two two', 'three']);
  });

  it('a 40 MB gRPC message in 64 KB chunks is joined once; split prefixes are fine', () => {
    const len = 40 * 1024 * 1024;
    const got: number[] = [];
    const reader = grpcMessageReader((b) => got.push(b.length));
    const prefix = Buffer.alloc(5);
    prefix.writeUInt32BE(len, 1);
    const body = Buffer.alloc(len, 1);
    const t0 = performance.now();
    reader.push(prefix.subarray(0, 2));
    reader.push(prefix.subarray(2));
    for (let at = 0; at < len; at += 65536) reader.push(body.subarray(at, Math.min(len, at + 65536)));
    const ms = performance.now() - t0;
    expect(got).toEqual([len]);
    expect(ms).toBeLessThan(1000 * SLACK);
  });

  it('a gzip bomb is refused, not expanded', () => {
    const bomb = gzipSync(Buffer.alloc(200 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(400_000);
    // left as it is (the bytes of the message), never 200 MB of memory
    expect(grpcDecompress(bomb, 'gzip').length).toBe(bomb.length);
    expect(grpcDecompress(gzipSync(Buffer.from('fine')), 'gzip').toString()).toBe('fine');
  });

  it('a 10 MB single-line SSE event in 16 KB chunks (debugger and client parsers)', () => {
    const line = 'data: ' + 'x'.repeat(10 * 1024 * 1024) + '\n\n';
    const chunks: string[] = [];
    for (let at = 0; at < line.length; at += 16384) chunks.push(line.slice(at, at + 16384));
    const t0 = performance.now();
    const seen: number[] = [];
    const dbg = sseParser((e) => seen.push(e.data.length), 20 * 1024 * 1024);
    for (const c of chunks) dbg.push(Buffer.from(c));
    dbg.end();
    const t1 = performance.now();
    const client = new SseParser();
    let events = 0;
    for (const c of chunks) events += client.push(c).length;
    const t2 = performance.now();
    console.log(`10 MB SSE line: debugger ${(t1 - t0).toFixed(0)} ms, client ${(t2 - t1).toFixed(0)} ms`);
    expect(seen).toEqual([10 * 1024 * 1024]);
    expect(events).toBe(1);
    expect(t1 - t0).toBeLessThan(500 * SLACK);
    expect(t2 - t1).toBeLessThan(500 * SLACK);
  });
});

// Mem-3: frames, events and gRPC messages were outside the session's body budget (~32 MB per streaming exchange, 5,000 allowed)
import { DebuggerSession, type DebuggerExchange, type WebSocketFrame } from '../../packages/core/src/index.js';

describe('the session budget counts streams', () => {
  it('1,000 WebSocket exchanges of 500 frames stay inside the budget; the oldest lose their frames, not their rows', () => {
    const budget = 20 * 1024 * 1024;
    const s = new DebuggerSession({ maxBodyBytes: budget });
    const text = 'x'.repeat(1024);
    for (let i = 0; i < 1000; i++) {
      const frames: WebSocketFrame[] = Array.from({ length: 500 }, () => ({ at: '2026-10-22T00:00:00Z', direction: 'received', opcode: 'text', bytes: 1024, text }));
      s.add({ id: `ws${i}`, startedAt: '2026-10-22T00:00:00Z', kind: 'websocket', method: 'GET', url: `ws://h/${i}`, host: 'h', clientPort: 1, requestHeaders: {}, requestBodyBytes: 0, responseBodyBytes: 0, frames } as DebuggerExchange);
    }
    expect(s.bodyBytes).toBeLessThanOrEqual(budget + 600 * 1024); // (the newest exchange is never dropped, so one over)
    expect(s.length).toBe(1000);
    expect(s.items[0]!.frames).toBeUndefined();
    expect(s.items[0]!.bodiesDropped).toBe(true);
    expect(s.items[999]!.frames).toHaveLength(500);
  });
});
