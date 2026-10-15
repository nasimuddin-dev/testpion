import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openMetaStore, type RunSummary } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// Two processes on one workspace (the app and a CLI run, CI jobs side by side): one opening the run history while the
// other writes waits for the lock. It used to fail at once and fall back to metadata.jsonl, so the run it recorded was
// missing from the history the app shows (found by the evaluation matrix e2e plan, which runs four CLI evaluations at once).
const tmp = tempDir('tp-meta-lock-');
afterAll(() => tmp.cleanup());

const summary = (runId: string) => ({ runId, name: runId, startedAt: new Date().toISOString(), durationMs: 1, total: 1, passed: 1, failed: 0, skipped: 0, errors: 0 }) as RunSummary;

describe('the run history under another process’s lock', () => {
  it('waits for the lock and records into the database, not a fallback file', async () => {
    const first = openMetaStore(tmp.dir);
    if (first.backend !== 'sqlite') return; // no node:sqlite here: nothing to lock
    first.addRun(summary('run-before'), tmp.dir);
    first.close?.();
    // another process takes the write lock and holds it for a moment
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(join(tmp.dir, 'database.sqlite'))});
         db.exec('BEGIN EXCLUSIVE'); process.stdout.write('locked\\n'); const end = Date.now() + 700; while (Date.now() < end); db.exec('COMMIT'); db.close();`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise<void>((ok) => holder.stdout!.once('data', () => ok()));
    const t0 = Date.now();
    const meta = openMetaStore(tmp.dir);
    meta.addRun(summary('run-while-locked'), tmp.dir);
    const waited = Date.now() - t0;
    expect(meta.backend).toBe('sqlite');
    expect(
      meta
        .listRuns()
        .items.map((r) => r.id)
        .sort(),
    ).toEqual(['run-before', 'run-while-locked']);
    expect(existsSync(join(tmp.dir, 'metadata.jsonl'))).toBe(false);
    expect(waited).toBeLessThan(10_000);
    meta.close?.();
    await new Promise((r) => holder.once('exit', r));
  }, 30_000);
});
