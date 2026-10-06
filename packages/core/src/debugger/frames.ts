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
}

export interface DebuggerSseEvent {
  at: string;
  event?: string;
  id?: string;
  data: string;
}

const OPCODES: Record<number, WebSocketFrame['opcode']> = { 0: 'continuation', 1: 'text', 2: 'binary', 8: 'close', 9: 'ping', 10: 'pong' };

/** Reads WebSocket frames from a stream of bytes in one direction; call `push` with every chunk. */
export function webSocketFrameParser(direction: WebSocketFrame['direction'], onFrame: (f: WebSocketFrame) => void, maxText = 64 * 1024): { push(chunk: Buffer): void } {
  let buf: Buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0]!;
        const b1 = buf[1]!;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) return;
        const mask = masked ? buf.subarray(off, off + 4) : undefined;
        let payload = buf.subarray(off + maskLen, off + maskLen + len);
        if (mask) {
          const un = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) un[i] = payload[i]! ^ mask[i & 3]!;
          payload = un;
        }
        const opcode = OPCODES[b0 & 0x0f] ?? 'other';
        const frame: WebSocketFrame = { at: new Date().toISOString(), direction, opcode, bytes: len };
        if (opcode === 'text' || opcode === 'continuation' || (opcode === 'binary' && looksText(payload))) {
          frame.text = payload.subarray(0, maxText).toString('utf8');
          frame.truncated = payload.length > maxText;
        } else if (opcode === 'close' && payload.length >= 2) frame.text = `code ${payload.readUInt16BE(0)}${payload.length > 2 ? ` ${payload.subarray(2, 2 + maxText).toString('utf8')}` : ''}`;
        onFrame(frame);
        buf = buf.subarray(off + maskLen + len);
      }
    },
  };
}

const looksText = (b: Buffer) => {
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
      rest += chunk.toString('utf8');
      const lines = rest.split(/\r\n|\n|\r/);
      rest = lines.pop() ?? '';
      for (const l of lines) line(l);
    },
    end() {
      if (rest) line(rest);
      rest = '';
      flush();
    },
  };
}
