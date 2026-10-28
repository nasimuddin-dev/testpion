import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { appendFile as appendFileP } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Redactor } from '../util/redact.js';
import { restrictToOwner } from '../storage/private-acl.js';

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE';
const ORDER: Record<LogLevel, number> = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };

export interface LogRecord {
  time: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

/** A sink; one that buffers has `flush()` (writes what it holds now). */
export type LogSink = ((rec: LogRecord) => void) & { flush?: () => void };

/**
 * Structured logger. Every record passes through the redactor before reaching any sink,
 * so debug logging can be enabled without exposing secrets.
 */
export class Logger {
  private sinks: LogSink[] = [];
  private level: LogLevel;
  /** Children share level and sinks with their root logger. */
  private root: Logger = this;

  constructor(
    level: LogLevel = 'INFO',
    readonly redactor: Redactor = new Redactor(),
    private scope = 'aps',
  ) {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.root.level = level;
  }

  getLevel(): LogLevel {
    return this.root.level;
  }

  addSink(sink: LogSink): () => void {
    const root = this.root;
    root.sinks.push(sink);
    return () => {
      root.sinks = root.sinks.filter((s) => s !== sink);
    };
  }

  child(scope: string): Logger {
    const c = new Logger(this.root.level, this.redactor, `${this.scope}:${scope}`);
    c.root = this.root;
    return c;
  }

  enabled(level: LogLevel): boolean {
    return ORDER[level] <= ORDER[this.root.level];
  }

  log(level: LogLevel, message: string, data?: unknown): void {
    const sinks = this.root.sinks;
    if (!this.enabled(level) || !sinks.length) return;
    const rec: LogRecord = {
      time: new Date().toISOString(),
      level,
      scope: this.scope,
      message: this.redactor.redactString(message),
      data: data === undefined ? undefined : this.redactor.redact(data),
    };
    for (const s of sinks) {
      try {
        s(rec);
      } catch {
        /* never let a sink crash the caller */
      }
    }
  }

  error(m: string, d?: unknown): void {
    this.log('ERROR', m, d);
  }
  warn(m: string, d?: unknown): void {
    this.log('WARN', m, d);
  }
  info(m: string, d?: unknown): void {
    this.log('INFO', m, d);
  }
  debug(m: string, d?: unknown): void {
    this.log('DEBUG', m, d);
  }
  trace(m: string, d?: unknown): void {
    this.log('TRACE', m, d);
  }
}

/** Sinks that may hold lines not yet written, flushed when the process exits (the newest 64: a session's sink leaves with its Backend). */
const liveSinks = new Set<() => void>(); // bounded: trimmed to 64 below
let exitHooked = false; // bounded: a flag
const PENDING_CAP = 2 * 1024 * 1024;

/**
 * JSON-lines file sink with simple size-based rotation. INFO and below are batched: a record is a string in memory, and the batch
 * is appended with one asynchronous write a few milliseconds later (at TRACE level a record is written per RPC; a synchronous
 * append per record stalled the thread on a slow disk). WARN and ERROR go out at once and synchronously, after whatever is pending,
 * so a crash right after them still finds them; the process exit writes what is left. The buffer is bounded (2 MB: the oldest
 * lines are dropped, and the file says how many). `flush()` writes everything now (tests, shutdown).
 * The sink counts the bytes it wrote and reads the size again every 200 writes, since another process (a CLI run) may append to
 * the same file. No handle is kept open (Windows cannot rename or remove a file that is).
 */
export function fileSink(path: string, maxBytes = 10 * 1024 * 1024): LogSink {
  // the log can hold what an error message carried: readable by this account only (POSIX; Windows keeps the profile's permissions)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let restricted = false;
  let bytes = statSync(path, { throwIfNoEntry: false })?.size ?? 0; // re-read every 200 writes
  let sinceStat = 0;
  let pending: string[] = [];
  let pendingBytes = 0;
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The text to write now, with the rotation decided first. */
  const take = (): string => {
    clearTimeout(timer);
    timer = undefined;
    const note = dropped ? JSON.stringify({ time: new Date().toISOString(), level: 'WARN', scope: 'log', message: `${dropped} log lines were dropped (the writer fell behind)` }) + '\n' : '';
    const text = note + pending.join('');
    pending = [];
    pendingBytes = 0;
    dropped = 0;
    if (!text) return '';
    try {
      if (++sinceStat >= 200) {
        bytes = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
        sinceStat = 0;
      }
      if (bytes > maxBytes) {
        renameSync(path, `${path}.1`);
        bytes = 0;
      }
    } catch {
      /* ignore */
    }
    bytes += Buffer.byteLength(text);
    return text;
  };
  const restrict = () => {
    if (restricted) return;
    restricted = true;
    restrictToOwner(dirname(path), 'dir'); // Windows: this user only (best effort, once)
    restrictToOwner(path, 'file');
  };
  const flush = (): void => {
    const text = take();
    if (!text) return;
    appendFileSync(path, text, { mode: 0o600 });
    restrict();
  };
  const sink: LogSink = (rec) => {
    const line = JSON.stringify(rec) + '\n';
    pending.push(line);
    pendingBytes += line.length;
    if (bytes + pendingBytes > maxBytes) return flush(); // this write rotates the file: not as part of a big batch
    if (rec.level === 'ERROR' || rec.level === 'WARN') return flush();
    if (pendingBytes > PENDING_CAP) {
      const cut = pending.length >> 1;
      dropped += cut;
      pendingBytes -= pending.splice(0, cut).reduce((n, l) => n + l.length, 0);
    }
    timer ??= setTimeout(() => {
      timer = undefined;
      const text = take();
      if (text) appendFileP(path, text, { mode: 0o600 }).then(restrict, () => undefined);
    }, 20);
    timer.unref();
  };
  sink.flush = flush;
  liveSinks.add(flush);
  if (liveSinks.size > 64) liveSinks.delete(liveSinks.values().next().value!);
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', () => {
      for (const f of liveSinks) {
        try {
          f();
        } catch {
          /* the process is ending */
        }
      }
    });
  }
  return sink;
}

export function consoleSink(minLevel: LogLevel = 'TRACE'): LogSink {
  return (rec) => {
    if (ORDER[rec.level] > ORDER[minLevel]) return;
    const line = `[${rec.time}] ${rec.level.padEnd(5)} ${rec.scope} ${rec.message}${rec.data !== undefined ? ' ' + JSON.stringify(rec.data) : ''}`;
    console.error(line);
  };
}
