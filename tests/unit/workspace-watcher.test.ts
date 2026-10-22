import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, changeKind, describeChanges, watchWorkspace, type WorkspaceChange } from '@testpion/core';

// GIT-103: a workspace notices changes made outside the app (git pull, another editor), not its own saves.
const root = mkdtempSync(join(tmpdir(), 'tp-watch-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('workspace watcher', () => {
  it('sorts paths by what they are, and ignores results and local state', () => {
    expect(changeKind('collections/shop.json')).toBe('collections');
    expect(changeKind('environments/dev.json')).toBe('environments');
    expect(changeKind('tests/rest/a.yaml')).toBe('tests');
    expect(changeKind('mcp-servers.json')).toBe('mcp');
    expect(changeKind('workspace.json')).toBe('workspace');
    for (const p of ['runs/r1/results.jsonl', 'traces/t.json', '.local/meta.json', '.git/index', 'database.sqlite-wal', 'collections/shop.json.tmp-123-abcd1234']) expect(changeKind(p)).toBeUndefined();
  });

  it('describes a batch in words', () => {
    const c: WorkspaceChange[] = [
      { path: 'collections/a.json', kind: 'collections' },
      { path: 'collections/b.json', kind: 'collections' },
      { path: 'environments/dev.json', kind: 'environments' },
    ];
    expect(describeChanges(c)).toBe('2 collections, 1 environment changed outside TestPion');
  });

  it('reports outside changes once things are quiet, and not the app’s own writes', async () => {
    for (const d of ['collections', 'runs']) mkdirSync(join(root, d), { recursive: true });
    const batches: WorkspaceChange[][] = [];
    const stop = watchWorkspace(root, (b) => batches.push(b), { debounceMs: 150 });
    try {
      await sleep(200);
      atomicWrite(join(root, 'collections', 'own.json'), '{}\n'); // the app's own save
      writeFileSync(join(root, 'runs', 'r.json'), '{}'); // a result
      await sleep(600);
      expect(batches.flat().map((c) => c.path)).not.toContain('collections/own.json');
      writeFileSync(join(root, 'collections', 'pulled.json'), '{}'); // another program
      writeFileSync(join(root, 'collections', 'pulled.json'), '{"a":1}');
      await sleep(800);
      const paths = batches.flat().map((c) => c.path);
      expect(paths).toContain('collections/pulled.json');
      expect(paths.filter((p) => p === 'collections/pulled.json')).toHaveLength(1); // one entry per batch
      expect(paths.some((p) => p.startsWith('runs/'))).toBe(false);
    } finally {
      stop();
    }
  });

  it('an event that names no file (the system buffer overflowed: a merge while the app was busy) looks at every file again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-watch-overflow-'));
    try {
      mkdirSync(join(dir, 'collections'), { recursive: true });
      writeFileSync(join(dir, 'collections', 'a.json'), '{"a":1}');
      writeFileSync(join(dir, 'collections', 'b.json'), '{"b":1}');
      writeFileSync(join(dir, 'mcp-servers.json'), '{"servers":[]}');
      let emit!: (name: string | null) => void;
      const batches: WorkspaceChange[][] = [];
      const stop = watchWorkspace(dir, (b) => batches.push(b), { debounceMs: 50, watch: (_r, l) => ((emit = (n) => l('change', n)), { close: () => undefined }) });
      try {
        await sleep(50);
        // the merge: one file rewritten, one gone, one new; the only event is the one without a name
        writeFileSync(join(dir, 'mcp-servers.json'), '<<<<<<< HEAD\n{"servers":[1]}\n=======\n{"servers":[2]}\n>>>>>>> theirs\n');
        rmSync(join(dir, 'collections', 'b.json'));
        writeFileSync(join(dir, 'collections', 'c.json'), '{"c":1}');
        emit(null);
        await sleep(300);
        expect(batches.flat().map((c) => c.path).sort()).toEqual(['collections/b.json', 'collections/c.json', 'mcp-servers.json']);
      } finally {
        stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a nameless event does not report what the app itself just wrote (only the outside change in the same burst)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-watch-overflow-own-'));
    try {
      mkdirSync(join(dir, 'collections'), { recursive: true });
      writeFileSync(join(dir, 'collections', 'mine.json'), '{"a":1}');
      writeFileSync(join(dir, 'collections', 'theirs.json'), '{"a":1}');
      let emit!: (name: string | null) => void;
      const batches: WorkspaceChange[][] = [];
      const stop = watchWorkspace(dir, (b) => batches.push(b), { debounceMs: 50, watch: (_r, l) => ((emit = (n) => l('change', n)), { close: () => undefined }) });
      try {
        await sleep(50);
        atomicWrite(join(dir, 'collections', 'mine.json'), '{"a":2}'); // the app's save
        writeFileSync(join(dir, 'collections', 'theirs.json'), '{"a":3}'); // another program
        emit(null);
        await sleep(300);
        expect(batches.flat().map((c) => c.path)).toEqual(['collections/theirs.json']);
      } finally {
        stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a change another program makes right after the app saved the same file', async () => {
    mkdirSync(join(root, 'tests'), { recursive: true });
    const batches: WorkspaceChange[][] = [];
    const stop = watchWorkspace(root, (b) => batches.push(b), { debounceMs: 150 });
    try {
      await sleep(200);
      atomicWrite(join(root, 'tests', 'flow.yaml'), 'name: Flow\ntests: []\n'); // the app's save
      await sleep(300);
      expect(batches.flat().map((c) => c.path)).not.toContain('tests/flow.yaml');
      writeFileSync(join(root, 'tests', 'flow.yaml'), 'name: Flow\ntests: [ { name: x, url: http://x } ]\n'); // an editor, within the 2 s
      await sleep(800);
      expect(batches.flat().map((c) => c.path)).toContain('tests/flow.yaml');
    } finally {
      stop();
    }
  });

  it('does not report a file that was only read (Windows reports the access time as a change)', async () => {
    mkdirSync(join(root, 'tests'), { recursive: true });
    const file = join(root, 'tests', 'rag.yaml');
    writeFileSync(file, 'name: x\n');
    const batches: WorkspaceChange[][] = [];
    const stop = watchWorkspace(root, (b) => batches.push(b), { debounceMs: 150 });
    try {
      await sleep(200);
      readFileSync(file, 'utf8');
      const st = statSync(file);
      utimesSync(file, new Date(), st.mtime); // only the access time moves
      await sleep(600);
      expect(batches.flat().map((c) => c.path)).toEqual([]);
      writeFileSync(file, 'name: changed\n');
      await sleep(600);
      expect(batches.flat().map((c) => c.path)).toEqual(['tests/rag.yaml']);
    } finally {
      stop();
    }
  });
});
