/**
 * Server-Sent Events (text/event-stream) parsing, per the HTML standard's event stream format:
 * `field: value` lines, events dispatched on a blank line, `data` lines joined with newlines,
 * comment lines (`:`) ignored. Used to show an SSE response event by event, live.
 */
export interface SseEvent {
  /** Event type (`event:` field), "message" when not set. */
  event: string;
  data: string;
  id?: string;
  retry?: number;
  /** Milliseconds from the start of the request until the event arrived. */
  atMs: number;
}

export class SseParser {
  /** The text since the last line break, in pieces (joined only when a line break arrives: a long line in many chunks is not copied again for each). */
  private partial: string[] = [];
  private data: string[] = [];
  private event = '';
  private id?: string;
  private retry?: number;
  private first = true;
  private afterCR = false;

  /** Feed decoded text; returns the events completed by it. */
  push(text: string, atMs = 0): SseEvent[] {
    if (this.first) {
      text = text.replace(/^\uFEFF/, '');
      this.first = false;
    }
    // a \r ends a line straight away; a \n right after it (a \r\n split across chunks) is skipped
    if (this.afterCR && text.startsWith('\n')) text = text.slice(1);
    if (!text) return [];
    if (!/[\r\n]/.test(text)) {
      this.partial.push(text);
      this.afterCR = false;
      return [];
    }
    const buffer = this.partial.length ? this.partial.join('') + text : text;
    this.partial = [];
    const out: SseEvent[] = [];
    const lineBreak = /\r\n|\n|\r/g;
    let from = 0;
    for (;;) {
      lineBreak.lastIndex = from;
      const m = lineBreak.exec(buffer);
      if (!m) break;
      const line = buffer.slice(from, m.index);
      from = m.index + m[0].length;
      this.afterCR = m[0] === '\r' && from === buffer.length;
      const ev = this.line(line, atMs);
      if (ev) out.push(ev);
    }
    if (from < buffer.length) {
      this.partial.push(buffer.slice(from));
      this.afterCR = false;
    }
    return out;
  }

  /** End of stream: an event without its final blank line is dropped, as browsers do. */
  flush(): SseEvent[] {
    this.partial = [];
    this.data = [];
    this.event = '';
    return [];
  }

  private line(line: string, atMs: number): SseEvent | undefined {
    if (line === '') {
      if (!this.data.length) {
        this.event = '';
        return undefined;
      }
      const ev: SseEvent = { event: this.event || 'message', data: this.data.join('\n'), atMs };
      if (this.id !== undefined) ev.id = this.id;
      if (this.retry !== undefined) ev.retry = this.retry;
      this.data = [];
      this.event = '';
      this.retry = undefined;
      return ev;
    }
    if (line.startsWith(':')) return undefined;
    const c = line.indexOf(':');
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? '' : line.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\0')) this.id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Number(value);
    return undefined;
  }
}

/** All events in a complete event-stream text. */
export function parseSse(text: string): SseEvent[] {
  return new SseParser().push(text.endsWith('\n') ? text : `${text}\n`);
}

export const isEventStream = (contentType: string | null | undefined) => /^\s*text\/event-stream/i.test(contentType ?? '');
