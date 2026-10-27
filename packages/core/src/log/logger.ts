import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
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

export type LogSink = (rec: LogRecord) => void;

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

/**
 * JSON-lines file sink with simple size-based rotation. The sink counts the bytes it wrote, so a record is one append (it was a
 * stat and an append: at TRACE level a record is written per RPC); the size is read again every 200 records, since another process
 * (a CLI run) may append to the same file. No handle is kept open (Windows cannot rename or remove a file that is).
 */
export function fileSink(path: string, maxBytes = 10 * 1024 * 1024): LogSink {
  // the log can hold what an error message carried: readable by this account only (POSIX; Windows keeps the profile's permissions)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let restricted = false;
  let bytes = -1; // unknown: read at the first record
  let sinceStat = 0;
  return (rec) => {
    const line = JSON.stringify(rec) + '\n';
    try {
      if (bytes < 0 || ++sinceStat >= 200) {
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
    appendFileSync(path, line, { mode: 0o600 });
    bytes += Buffer.byteLength(line);
    if (!restricted) {
      restricted = true;
      restrictToOwner(dirname(path), 'dir'); // Windows: this user only (best effort, once)
      restrictToOwner(path, 'file');
    }
  };
}

export function consoleSink(minLevel: LogLevel = 'TRACE'): LogSink {
  return (rec) => {
    if (ORDER[rec.level] > ORDER[minLevel]) return;
    const line = `[${rec.time}] ${rec.level.padEnd(5)} ${rec.scope} ${rec.message}${rec.data !== undefined ? ' ' + JSON.stringify(rec.data) : ''}`;
    console.error(line);
  };
}
