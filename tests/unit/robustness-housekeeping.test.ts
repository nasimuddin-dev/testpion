import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  atomicWrite,
  collectDiagnostics,
  diagnosticsSummary,
  diagnosticsZip,
  expireTrash,
  isDue,
  listTrash,
  nextRunAt,
  sweepWorkspace,
  watchWorkspace,
  WorkspaceStore,
  type Monitor,
  type MonitorResult,
} from '../../packages/core/src/index.js';
import { retryDelayMs } from '../../packages/core/src/protocols/http/client.js';
import { fileLines } from '../../packages/core/src/util/file-lines.js';
import { tempDir } from '../helpers.js';

/** The P2 items of planning/review-2026-10-22-robustness.md: housekeeping, version gates, watcher, clock, jitter, diagnostics. */
const tmp = tempDir('tp-robust-hk-');
afterAll(() => tmp.cleanup());
let n = 0;
const ws = () => WorkspaceStore.create(join(tmp.dir, `w${n++}`), 'W');
const old = (path: string, ms: number) => {
  const t = new Date(Date.now() - ms);
  utimesSync(path, t, t);
};
const DAY = 86_400_000;

describe('R-2 / R-4 / C-3 leftovers', () => {
  it('removes stale temp files, orphan payloads, unfinished run folders and old inline files; keeps what is in use', () => {
    const store = ws();
    const root = store.root;
    // temp files: one of a dead process, one of this live process (fresh), one a day old
    const dead = join(root, 'collections', 'a.json.tmp-999999-abcd1234');
    const live = join(root, 'collections', `b.json.tmp-${process.pid}-abcd1234`);
    const ancient = join(root, 'environments', `c.json.tmp-${process.pid}-ffff0000`);
    for (const f of [dead, live, ancient]) writeFileSync(f, '{}');
    old(dead, 120_000);
    old(ancient, 2 * DAY);
    // payloads: one a history row points at, one nobody does (old), one nobody does (new: a send in progress)
    mkdirSync(join(root, 'payloads'), { recursive: true });
    const kept = join(root, 'payloads', 'kept.bin');
    const orphan = join(root, 'payloads', 'orphan.bin');
    const fresh = join(root, 'payloads', 'fresh.bin');
    for (const f of [kept, orphan, fresh]) writeFileSync(f, 'x');
    old(kept, 3 * DAY);
    old(orphan, 3 * DAY);
    store.meta.addHistory({ id: 'h1', timestamp: new Date().toISOString(), kind: 'http', name: 'n', request: {}, payloadPath: kept } as never);
    // runs: one with a summary and a row, one without either and idle, one without either but writing now, one in progress by id
    for (const id of ['done', 'cut-short', 'writing', 'paused']) mkdirSync(join(root, 'runs', id), { recursive: true });
    writeFileSync(join(root, 'runs', 'done', 'summary.json'), '{}');
    for (const id of ['cut-short', 'paused']) {
      writeFileSync(join(root, 'runs', id, 'results.jsonl'), '');
      old(join(root, 'runs', id, 'results.jsonl'), 2 * 3_600_000);
      old(join(root, 'runs', id), 2 * 3_600_000);
    }
    writeFileSync(join(root, 'runs', 'writing', 'results.jsonl'), '{}\n');
    mkdirSync(join(root, 'runs', '.inline'), { recursive: true });
    writeFileSync(join(root, 'runs', '.inline', 'old.jsonl'), '{}');
    writeFileSync(join(root, 'runs', '.inline', 'new.jsonl'), '{}');
    old(join(root, 'runs', '.inline', 'old.jsonl'), 2 * 3_600_000);

    const r = sweepWorkspace(store, { keepRuns: ['paused'] });
    expect(r).toMatchObject({ tmp: 2, payloads: 1, runs: 1, inline: 1 });
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(ancient)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(readdirSync(join(root, 'runs')).sort()).toEqual(['.inline', 'done', 'paused', 'writing']);
    expect(readdirSync(join(root, 'runs', '.inline'))).toEqual(['new.jsonl']);
    store.close();
  });
});

describe('D-5 the trash', () => {
  it('listing never deletes; expireTrash removes what is past 30 days', () => {
    const store = ws();
    store.saveEnvironment({ id: 'e1', name: 'E1', variables: [] } as never);
    store.deleteEnvironment('e1');
    expect(listTrash(store)).toHaveLength(1);
    const future = Date.now() + 40 * DAY; // a clock that is 40 days ahead
    expect(listTrash(store, future)).toHaveLength(0); // not shown …
    expect(listTrash(store)).toHaveLength(1); // … and not deleted
    expect(expireTrash(store, future)).toBe(1);
    expect(listTrash(store)).toHaveLength(0);
    store.close();
  });
});

describe('E-7 the watcher says why it stopped, and starts again', () => {
  it('reports a failing watch once per failure and retries after the wait', async () => {
    const problems: Array<[string, string | undefined]> = [];
    let starts = 0;
    let fail: ((e: Error) => void) | undefined;
    const source = (_root: string, _l: unknown, onError?: (e: Error) => void) => {
      starts++;
      fail = onError;
      return { close: () => undefined };
    };
    const stop = watchWorkspace(tmp.dir, () => undefined, { watch: source as never, onProblem: (m, c) => problems.push([m, c]) });
    expect(starts).toBe(1);
    fail!(Object.assign(new Error('limit'), { code: 'ENOSPC' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]![1]).toBe('ENOSPC');
    expect(problems[0]![0]).toMatch(/Not watching .* \(ENOSPC\); trying again in 1 s/);
    await new Promise((r) => setTimeout(r, 1300));
    expect(starts).toBe(2); // started again
    stop();
  }, 10_000);

  it('a watch that cannot start at all is reported, not silent', () => {
    const problems: string[] = [];
    const stop = watchWorkspace(tmp.dir, () => undefined, {
      watch: () => {
        throw Object.assign(new Error('nope'), { code: 'EPERM' });
      },
      onProblem: (m) => problems.push(m),
    });
    expect(problems[0]).toMatch(/EPERM/);
    stop();
  });
});

describe('D-1 a file from a newer TestPion', () => {
  it('is listed with why, never rewritten', () => {
    const store = ws();
    const file = join(store.root, 'collections', 'future.json');
    const text = JSON.stringify({ schemaVersion: '9.0', id: 'future', name: 'Future', items: [{ shiny: true }] });
    writeFileSync(file, text);
    const listed = store.listCollections().find((c) => c.id === 'future');
    expect(listed?.problem).toMatch(/written by a newer TestPion/);
    expect(() => store.saveCollection({ id: 'future', name: 'Future', version: 0, items: [], variables: [], updatedAt: '', schemaVersion: '1.0' } as never)).toThrow(/newer TestPion/);
    expect(readFileSync(file, 'utf8')).toBe(text);
    // the same for an environment
    writeFileSync(join(store.root, 'environments', 'later.json'), JSON.stringify({ schemaVersion: '2.0', id: 'later', name: 'Later', variables: [] }));
    expect(store.listEnvironments().find((e) => e.id === 'later')?.problem).toMatch(/newer TestPion/);
    expect(() => store.saveEnvironment({ id: 'later', name: 'Later', variables: [] } as never)).toThrow(/newer TestPion/);
    // the same major is fine
    writeFileSync(join(store.root, 'collections', 'same.json'), JSON.stringify({ schemaVersion: '1.7', id: 'same', name: 'Same', items: [] }));
    expect(store.listCollections().find((c) => c.id === 'same')?.problem).toBeUndefined();
    store.close();
  });
});

describe('I-6 the monitor clock', () => {
  const monitor = { id: 'm', name: 'm', enabled: true, everyMinutes: 5 } as Monitor;
  it('a last run in the future (the clock was set back) does not delay the monitor for hours', () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    const last = { startedAt: new Date(now + 3 * 3_600_000).toISOString() } as MonitorResult;
    expect(nextRunAt(monitor, last, now)).toBe(now); // it "ran in the future": that clock reading is not trusted, the monitor is due
    expect(isDue(monitor, last, now)).toBe(true);
    const normal = { startedAt: new Date(now - 60_000).toISOString() } as MonitorResult;
    expect(nextRunAt(monitor, normal, now)).toBe(now - 60_000 + 5 * 60_000);
  });
});

describe('N-2 retry jitter', () => {
  it('spreads the waits of workers that failed together, within the upper half; Retry-After is exact; it can be turned off', () => {
    const waits = new Set(Array.from({ length: 100 }, () => retryDelayMs(500, 2)));
    expect(waits.size).toBeGreaterThan(20);
    for (const w of waits) {
      expect(w).toBeGreaterThanOrEqual(1000);
      expect(w).toBeLessThanOrEqual(2000);
    }
    expect(retryDelayMs(500, 2, undefined, false)).toBe(2000);
    expect(retryDelayMs(500, 2, 3000)).toBe(3000);
    expect(retryDelayMs(500, 9)).toBeLessThanOrEqual(10_000);
    expect(retryDelayMs(500, 0, undefined, true, () => 0)).toBe(250);
  });
});

describe('R-5 early-broken reads', () => {
  it('close the file at once', async () => {
    const file = join(tmp.dir, 'lines.jsonl');
    writeFileSync(file, Array.from({ length: 5000 }, (_, i) => `{"n":${i}}`).join('\n'));
    const handles = () => (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((r) => r === 'FSReqCallback' || r === 'FileHandle').length;
    const before = handles();
    for (let i = 0; i < 300; i++) {
      for await (const l of fileLines(file)) {
        void l;
        break;
      }
    }
    expect(handles() - before).toBeLessThan(5);
    const all: string[] = [];
    for await (const l of fileLines(file)) all.push(l);
    expect(all).toHaveLength(5000);
  });
});

describe('O-1 diagnostics', () => {
  it('has no secret value and no home path, and says what is wrong', () => {
    const home = process.platform === 'win32' ? 'C:\\Users\\alice' : '/home/alice';
    const d = collectDiagnostics({
      settings: { proxy: { mode: 'custom', url: `http://bob:hunter2pass@proxy:8080` }, workspacePaths: [`${home}\\work\\ws`], apiKey: 'sk-live-0123456789abcdef0123', theme: 'dark' },
      logLines: [`2026-10-22 ERROR scope Could not read ${home}\\work\\ws\\collections\\a.json`, 'Authorization: Bearer abcdef0123456789abcdef0123456789', '{"password":"correct-horse-battery"}'],
      problems: ['The disk is full'],
      slowRpcs: [{ method: 'col.get', ms: 400, at: new Date().toISOString() }],
      workspace: { collections: 3 },
    });
    const text = JSON.stringify(d);
    for (const secret of ['hunter2pass', 'sk-live-0123456789abcdef0123', 'abcdef0123456789abcdef0123456789', 'correct-horse-battery', 'alice']) expect(text).not.toContain(secret);
    expect(d.log).toHaveLength(3);
    const summary = diagnosticsSummary(d);
    expect(summary).toContain('The disk is full');
    expect(summary).toContain('400 ms  col.get');
    expect(diagnosticsZip(d).subarray(0, 2).toString()).toBe('PK');
  });
});

describe('D-4 monitor results are rewritten atomically', () => {
  it('leaves no temp file behind and keeps the newest results (see monitors.test.ts for the rest)', () => {
    // the compaction of the results file uses atomicWrite: the target is replaced whole
    const dir = tempDir('tp-atomic-');
    const f = join(dir.dir, 'm.jsonl');
    atomicWrite(f, 'a\nb\n');
    atomicWrite(f, 'b\n');
    expect(readFileSync(f, 'utf8')).toBe('b\n');
    expect(readdirSync(dir.dir)).toEqual(['m.jsonl']);
    dir.cleanup();
  });
});

describe('R-6 module-level maps are bounded or say what they are', () => {
  const src = resolve('packages/core/src');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(src);

  it('every module-level Map or Set that is not a constant carries a `bounded:` or `registry:` note', () => {
    const missing: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = /^(?:export )?(?:const|let) ([a-z][A-Za-z0-9_]*)(?:: [^=]+)? = new (?:Map|Set)\b/.exec(line);
        if (!m) return;
        if (/(bounded|registry):/.test(line) || /(bounded|registry):/.test(lines[i - 1] ?? '')) return;
        missing.push(`${relative(src, f).split(sep).join('/')}:${i + 1} ${m[1]}`);
      });
    }
    expect(missing).toEqual([]);
  });

  it('(sanity) the scan found the core sources', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(statSync(dirname(files[0]!)).isDirectory()).toBe(true);
  });
});
