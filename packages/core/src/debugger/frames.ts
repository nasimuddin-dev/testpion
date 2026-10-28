/**
 * WebSocket frames (RFC 6455) and Server-Sent Events as they pass through the HTTP Debugger's proxy (DBG-4): the
 * bytes keep flowing untouched; the parsers only read along and hand back what they saw.
 */
export interface WebSocketFrame {
  at: string;
  direction: 'sent' | 'received';
  opcode: 'text' | 'binary' | 'close' | 'ping' | 'pong' | 'continuation' | 'other';
  bytes: number;
  /** Text frames (and binary ones that look like text), up to the limit. */
  text?: string;
  truncated?: boolean;
  /** A frame rule acted on it: dropped (never forwarded), edited (forwarded changed) or held (paused, then forwarded). */
  ruled?: 'dropped' | 'edited' | 'held';
}

export interface DebuggerSseEvent {
  at: string;
  event?: string;
  id?: string;
  data: string;
}

/**
 * Bytes that arrive in pieces, joined only when enough have arrived to read the next unit. A 50 MB frame in 64 KB chunks was
 * joined again with everything before it on every chunk (about 20 GB copied); now it is joined once, when it is complete.
 */
export class ByteQueue {
  private chunks: Buffer[] = [];
  length = 0;
  /** The bytes needed before the next read is worth trying. */
  need = 0;
  add(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }
  /** Whether enough has arrived to try reading. */
  ready(): boolean {
    return this.length >= this.need;
  }
  /** Everything as one buffer (the pieces are joined once and replaced by the result). */
  all(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.length)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }
  /** Keep only \`rest\` (what is left after the units read). */
  set(rest: Buffer): void {
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
  }
}

const OPCODES: Record<number, WebSocketFrame['opcode']> = { 0: 'continuation', 1: 'text', 2: 'binary', 8: 'close', 9: 'ping', 10: 'pong' };

/** Reads WebSocket frames from a stream of bytes in one direction; call `push` with every chunk. */
export function webSocketFrameParser(direction: WebSocketFrame['direction'], onFrame: (f: WebSocketFrame) => void, maxText = 64 * 1024): { push(chunk: Buffer): void } {
  const queue = new ByteQueue();
  queue.need = 2;
  return {
    push(chunk: Buffer) {
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
        const masked = (b1 & 0x80) !== 0;
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
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) return wait(off + maskLen + len);
        const mask = masked ? buf.subarray(off, off + 4) : undefined;
        let payload = buf.subarray(off + maskLen, off + maskLen + len);
        if (mask) {
          const un = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) un[i] = payload[i]! ^ mask[i & 3]!;
          payload = un;
        }
        onFrame(describeFrame(direction, b0 & 0x0f, payload, maxText));
        buf = buf.subarray(off + maskLen + len);
      }
    },
  };
}

/** A frame as the list shows it: its direction, kind, size and (for text and close frames) its text. */
export function describeFrame(direction: WebSocketFrame['direction'], opcodeNumber: number, payload: Buffer, maxText = 64 * 1024): WebSocketFrame {
  const opcode = OPCODES[opcodeNumber] ?? 'other';
  const frame: WebSocketFrame = { at: new Date().toISOString(), direction, opcode, bytes: payload.length };
  if (opcode === 'text' || opcode === 'continuation' || (opcode === 'binary' && looksText(payload))) {
    frame.text = payload.subarray(0, maxText).toString('utf8');
    frame.truncated = payload.length > maxText;
  } else if (opcode === 'close' && payload.length >= 2) frame.text = `code ${payload.readUInt16BE(0)}${payload.length > 2 ? ` ${payload.subarray(2, 2 + maxText).toString('utf8')}` : ''}`;
  return frame;
}

export const looksText = (b: Buffer) => {
  const n = Math.min(b.length, 512);
  for (let i = 0; i < n; i++) {
    const c = b[i]!;
    if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) return false;
  }
  return n > 0;
};

/** Reads Server-Sent Events from a text/event-stream body; call `push` with every chunk, `end` at the end. */
export function sseParser(onEvent: (e: DebuggerSseEvent) => void, maxData = 64 * 1024): { push(chunk: Buffer): void; end(): void } {
  let rest = '';
  let event: string | undefined;
  let id: string | undefined;
  let data: string[] = [];
  const flush = () => {
    if (!data.length && !event && !id) return;
    const text = data.join('\n');
    onEvent({ at: new Date().toISOString(), event, id, data: text.length > maxData ? text.slice(0, maxData) + '…' : text });
    event = undefined;
    id = undefined;
    data = [];
  };
  const line = (l: string) => {
    if (l === '') return flush();
    if (l.startsWith(':')) return;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    const value = i < 0 ? '' : l.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  };
  return {
    push(chunk: Buffer) {
      // only the part up to the last line break is split; a long line still arriving is not scanned again for every chunk
      const text = chunk.toString('utf8');
      const cut = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
      if (cut < 0) {
        rest += text;
        return;
      }
      const lines = (rest + text.slice(0, cut + 1)).split(/\r\n|\n|\r/);
      rest = text.slice(cut + 1);
      lines.pop();
      for (const l of lines) line(l);
    },
    end() {
      if (rest) line(rest);
      rest = '';
      flush();
    },
  };
}
