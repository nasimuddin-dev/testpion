import { randomBytes } from 'node:crypto';
import { ByteQueue, describeFrame, looksText, type WebSocketFrame } from './frames.js';
import type { FrameSpec } from './rules.js';
import { replaceText } from './shaping.js';
import { compileUserRegex, safeTest } from '../util/safe-regex.js';
import type { BreakpointEdits, DebuggerExchange, DebuggerProxyOptions } from './proxy.js';

/**
 * WebSocket frame rules (FG-26): the frames of a connection pass through a relay that can drop one, change its text, hold it
 * back or pause it for editing. Only whole text frames (and binary ones that read as text) are touched: a message split into
 * fragments, a compressed one (the proxy asks the server not to compress while a frame rule is on) and the control frames
 * pass as they are. A frame over 4 MB ends the rules for that connection (the bytes keep flowing).
 */

/** What the rules decided for one frame. */
export interface FrameVerdict {
  drop?: boolean;
  /** The text to forward instead. */
  text?: string;
  delayMs?: number;
  held?: boolean;
}

const MAX_RULED_FRAME = 4 * 1024 * 1024;

/** The frame rules of a connection, applied to one frame's text in the direction it travels. `pause` holds a frame for the person to edit it. */
export function frameDecider(specs: FrameSpec[], direction: WebSocketFrame['direction'], pause?: (text: string, direction: WebSocketFrame['direction']) => Promise<{ drop?: boolean; text?: string } | undefined>) {
  return async (text: string): Promise<FrameVerdict> => {
    const v: FrameVerdict = {};
    let now = text;
    for (const s of specs) {
      if (s.direction && s.direction !== 'both' && s.direction !== direction) continue;
      if (s.when && !whenMatches(s.when, now)) continue;
      if (s.action === 'drop') return { drop: true };
      if (s.action === 'delay') v.delayMs = (v.delayMs ?? 0) + Math.min(Math.max(s.delayMs ?? 0, 0), 60_000);
      else if (s.action === 'replace') now = s.find ? replaceText(now, [{ find: s.find, replace: s.replace ?? '', regex: s.regex }]) : (s.replace ?? '');
      else if (s.action === 'break' && pause) {
        const r = await pause(now, direction);
        v.held = true;
        if (r?.drop) return { drop: true, held: true };
        if (r?.text !== undefined) now = r.text;
      }
    }
    if (now !== text) v.text = now;
    return v;
  };
}

function whenMatches(when: string, text: string): boolean {
  const m = /^\/(.+)\/([a-z]*)$/.exec(when.trim());
  if (!m) return text.includes(when);
  try {
    return safeTest(compileUserRegex(m[1]!, 'i', 'The frame filter'), text.slice(0, 4096)).matched;
  } catch {
    return false;
  }
}

/** One frame on the wire: FIN set, the opcode, the payload; masked (with a new key) when a program sends it, as the protocol says. */
export function encodeFrame(opcode: number, payload: Buffer, masked: boolean): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (len < 126) head[1] = len;
  else if (len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!masked) return Buffer.concat([head, payload]);
  head[1]! |= 0x80;
  const key = randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i]! ^ key[i & 3]!;
  return Buffer.concat([head, key, body]);
}

/**
 * The relay of one direction: bytes in, frames read, the rules asked about each text frame (in order, one at a time), bytes
 * written on. `onFrame` gets every frame as it was forwarded (a dropped one with `ruled: 'dropped'`).
 */
export function createFrameRelay(o: {
  direction: WebSocketFrame['direction'];
  decide(text: string): Promise<FrameVerdict>;
  write(bytes: Buffer): void;
  onFrame(f: WebSocketFrame): void;
}): { push(chunk: Buffer): void } {
  const queue = new ByteQueue();
  queue.need = 2;
  const masked = o.direction === 'sent';
  let bypass = false;
  let tail: Promise<void> = Promise.resolve();
  const handle = async (raw: Buffer, b0: number, payload: Buffer): Promise<void> => {
    const opcode = b0 & 0x0f;
    const ruled = (opcode === 1 || (opcode === 2 && looksText(payload))) && (b0 & 0xf0) === 0x80;
    if (!ruled) {
      o.onFrame(describeFrame(o.direction, opcode, payload));
      o.write(raw);
      return;
    }
    const v = await o.decide(payload.toString('utf8'));
    if (v.delayMs) await new Promise<void>((r) => setTimeout(r, v.delayMs));
    if (v.drop) {
      o.onFrame({ ...describeFrame(o.direction, opcode, payload), ruled: 'dropped' });
      return;
    }
    if (v.text !== undefined) {
      const out = Buffer.from(v.text, 'utf8');
      o.onFrame({ ...describeFrame(o.direction, opcode, out), ruled: 'edited' });
      o.write(encodeFrame(opcode, out, masked));
      return;
    }
    o.onFrame({ ...describeFrame(o.direction, opcode, payload), ...(v.held ? { ruled: 'held' as const } : {}) });
    o.write(raw);
  };
  const enqueue = (raw: Buffer, b0: number, payload: Buffer) => {
    tail = tail.then(() => handle(raw, b0, payload)).catch(() => o.write(raw));
  };
  return {
    push(chunk: Buffer) {
      if (bypass) {
        tail = tail.then(() => o.write(chunk));
        return;
      }
      queue.add(chunk);
      if (!queue.ready()) return;
      let buf = queue.all();
      const wait = (need: number) => {
        queue.set(buf);
        queue.need = need;
      };
      for (;;) {
        if (buf.length < 2) return wait(2);
        const b0 = buf[0]!;
        const b1 = buf[1]!;
        const isMasked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return wait(4);
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return wait(10);
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (len > MAX_RULED_FRAME) {
          // too big to hold for the rules: everything from here on goes through untouched
          bypass = true;
          const rest = buf;
          queue.set(Buffer.alloc(0));
          tail = tail.then(() => o.write(rest));
          return;
        }
        const total = off + (isMasked ? 4 : 0) + len;
        if (buf.length < total) return wait(total);
        const mask = isMasked ? buf.subarray(off, off + 4) : undefined;
        let payload = buf.subarray(off + (isMasked ? 4 : 0), total);
        if (mask) {
          const un = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) un[i] = payload[i]! ^ mask[i & 3]!;
          payload = un;
        }
        enqueue(Buffer.from(buf.subarray(0, total)), b0, payload);
        buf = buf.subarray(total);
      }
    },
  };
}

/**
 * "Break" on a frame: the frame is shown in the breakpoint panel as a request (sent) or a response (received) whose body is its
 * text; the person edits the body, continues, or aborts (the frame is dropped). The panel lets it go on after two minutes.
 */
export function frameBreaker(onBreakpoint: NonNullable<DebuggerProxyOptions['onBreakpoint']>, e: DebuggerExchange) {
  return async (text: string, direction: WebSocketFrame['direction']): Promise<{ drop?: boolean; text?: string } | undefined> => {
    const sent = direction === 'sent';
    const shown: DebuggerExchange = { ...e, frames: undefined, method: sent ? 'WS frame sent' : 'WS frame received', ...(sent ? { requestBody: text } : { responseBody: text }) };
    const edits: BreakpointEdits | undefined = await onBreakpoint(shown, sent ? 'request' : 'response').catch(() => undefined);
    if (edits?.abort) return { drop: true };
    return edits?.body !== undefined ? { text: edits.body } : undefined;
  };
}

/** The status line and headers of an upgrade answer (or the server's refusal of it), as the program is given them. */
export function responseHead(ures: { statusCode?: number; statusMessage?: string; headers: Record<string, string | string[] | undefined> }): string {
  const lines = [`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}`, ...Object.entries(ures.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v !== undefined ? [`${k}: ${v}`] : []))];
  return lines.join('\r\n') + '\r\n\r\n';
}
