import { describe, expect, it, vi } from 'vitest';
import { appendFileSync as realAppend, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileSink, type LogRecord } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// O-3: a log record is no longer a synchronous append on the calling thread (review 2026-10-27, robustness O-3).
const rec = (level: LogRecord['level'], message: string): LogRecord => ({ time: 'now', level, scope: 't', message });
const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogRecord);

describe('the file log sink', () => {
  it('INFO records are batched into one asynchronous append; WARN and ERROR are written at once, after what is pending', async () => {
    const dir = tempDir('tp-log-');
    const log = join(dir.dir, 'app.log');
    const sink = fileSink(log);
    for (let i = 0; i < 500; i++) sink(rec('INFO', `info ${i}`));
    expect(existsSync(log)).toBe(false); // nothing written on the caller's thread
    await vi.waitFor(() => expect(existsSync(log) && lines(log).length === 500).toBe(true), { timeout: 2000 });
    expect(lines(log).map((r) => r.message)).toEqual(Array.from({ length: 500 }, (_, i) => `info ${i}`));
    sink(rec('INFO', 'pending'));
    sink(rec('ERROR', 'boom'));
    expect(lines(log).slice(-2).map((r) => r.message)).toEqual(['pending', 'boom']);
    dir.cleanup();
  });

  it('flush() writes what is pending now, and the buffer is bounded (the oldest lines go, and the file says how many)', () => {
    const dir = tempDir('tp-log-');
    const log = join(dir.dir, 'app.log');
    const sink = fileSink(log, 1e9);
    const big = 'x'.repeat(10_000);
    for (let i = 0; i < 600; i++) sink(rec('DEBUG', `${i} ${big}`)); // 6 MB offered, 2 MB kept
    sink.flush?.();
    const out = lines(log);
    expect(out.length).toBeLessThan(600);
    expect(out[0]!.message).toMatch(/log lines were dropped/);
    expect(out.at(-1)!.message.startsWith('599 ')).toBe(true);
    dir.cleanup();
  });
});
