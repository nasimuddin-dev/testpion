/**
 * A workspace reached through a link — what macOS does to every temp folder (/var → /private/var, /tmp → /private/tmp),
 * and what a junction or a linked home folder does elsewhere — is still itself, whichever way each path names it: the
 * store names it through the link, a CLI run records its files by their real path (the current folder of a process is
 * a real path), git reports real paths. Every place that relates a recorded path to the workspace does it the one way
 * (`relativeInside` / `samePath` in storage/fsutil.ts), so this suite runs the critical cases through a junction (Windows)
 * or a symlink (Linux, macOS): the macOS-only class fails on every CI.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  WorkspaceManager,
  WorkspaceStore,
  atomicWrite,
  gitStatus,
  runGit,
  ownWrite,
  pathMatcher,
  samePath,
  watchWorkspace,
  type WatchSource,
  type WorkspaceChange,
} from '../../packages/core/src/index.js';
import { ciTargetOfRun, resultSourceRefs, testsPathOf } from '../../packages/core/src/runner/result-source.js';
import { sourceOfResult } from '../../packages/core/src/ai/run-evidence.js';
import { flowRuns } from '../../packages/core/src/runner/flow-history.js';
import { runTimeline } from '../../packages/core/src/runner/flow-report.js';
import { flowOfFile } from '../../packages/core/src/runner/flow-steps.js';
import { ciPipelineFiles } from '../../packages/core/src/runner/flow-deploy.js';
import { installPreCommitHook, isInGitRepository } from '../../packages/core/src/storage/git-files.js';
import { OwnWrites, type OwnWriteBatch } from '../../apps/desktop/backend/own-writes.js';
import { cliData, runCliSync, tempDir } from '../helpers.js';
import { addRun, httpResult } from '../ai/run-fixtures.js';

const t = tempDir('tp-ws-alias-', { alias: true });
afterAll(() => t.cleanup());

const link = (target: string, at: string) => symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
const FLOW = 'name: Smoke\ntests:\n  - id: health\n    name: Health\n    url: http://127.0.0.1:9/health\n';

/** A workspace opened through the link (`ws.root` is the alias), its real folder, and a failed run that recorded the file by its real path. */
async function aliased(name: string) {
  const ws = WorkspaceStore.create(join(t.dir, name), name);
  ws.writeTestFile('smoke/health.yaml', FLOW);
  const real = join(t.real, name);
  const file = join(real, 'tests', 'smoke', 'health.yaml');
  const bad = { ...httpResult({ id: 'health', name: 'Health', url: 'http://127.0.0.1:9/health', status: 500, checks: [{ type: 'status', name: 'status 200', passed: false }] }), file };
  await addRun(ws, { id: 'run-1', startedAt: '2026-10-17T10:00:00.000Z', origin: { kind: 'tests', paths: [file] }, results: [bad] });
  return { ws, real, file, result: bad };
}

describe('a recorded real path maps to the workspace opened through a link', () => {
  it('result source, ItemRef, triage evidence and the CI target name the file under tests/', async () => {
    const { ws, file, result } = await aliased('refs');
    try {
      expect(ws.root).not.toBe(join(t.real, 'refs')); // really named apart
      expect(testsPathOf(ws, file)).toBe('smoke/health.yaml');
      expect(resultSourceRefs(ws, result)).toEqual([{ kind: 'test', path: 'smoke/health.yaml', step: 'health' }]);
      // what the triage and flaky analysis read: the file, so a fix of it can be proposed (the macOS CI failure)
      expect(sourceOfResult(ws, result, undefined)).toMatchObject({ kind: 'test', path: 'smoke/health.yaml', text: FLOW });
      const summary = JSON.parse(readFileSync(join(ws.runDir('run-1'), 'summary.json'), 'utf8'));
      expect(ciTargetOfRun(ws, summary).target).toEqual({ tests: ['smoke/health.yaml'] });
      // outside tests/ (by either name) is still outside
      expect(testsPathOf(ws, join(t.real, 'refs', 'collections', 'x.json'))).toBeUndefined();
      expect(testsPathOf(ws, join(t.real, 'refs-other', 'tests', 'x.yaml'))).toBeUndefined();
    } finally {
      ws.close();
    }
  });

  it('the same the other way round: the workspace opened by its real path, the file named through the link', async () => {
    const made = await aliased('reverse');
    made.ws.close();
    const ws = WorkspaceStore.open(made.real);
    try {
      expect(testsPathOf(ws, join(t.dir, 'reverse', 'tests', 'smoke', 'health.yaml'))).toBe('smoke/health.yaml');
    } finally {
      ws.close();
    }
  });

  it("a flow's runs, its timeline and the designer's step results find the run", async () => {
    const { ws } = await aliased('flow');
    try {
      expect((await flowRuns(ws, 'smoke/health.yaml')).runs.map((r) => [r.runId, r.status])).toEqual([['run-1', 'failed']]);
      expect((await runTimeline(ws, 'run-1', { file: 'smoke/health.yaml' })).timeline.bars.map((b) => b.id)).toEqual(['health']);
      expect((await flowOfFile(ws, 'smoke/health.yaml')).steps[0]).toMatchObject({ id: 'health', status: 'failed' });
    } finally {
      ws.close();
    }
  });

  it('pathMatcher and samePath: one file or folder by either name; a neighbour is not it', () => {
    const real = join(t.real, 'refs', 'tests', 'smoke', 'health.yaml');
    const named = join(t.dir, 'refs', 'tests', 'smoke', 'health.yaml');
    expect(pathMatcher(named)(real)).toBe(true);
    expect(pathMatcher(named)(join(t.real, 'refs', 'tests', 'smoke', 'other.yaml'))).toBe(false);
    expect(samePath(join(t.dir, 'refs'), join(t.real, 'refs'))).toBe(true);
    expect(samePath(join(t.dir, 'refs'), join(t.real, 'flow'))).toBe(false);
  });
});

describe("the app's own writes are its own by either name", () => {
  it('a write by the real path is known when asked through the link (and the other way), and the watcher does not report it', async () => {
    const root = join(t.dir, 'own');
    mkdirSync(join(root, 'tests'), { recursive: true });
    let listener: ((event: string, name: string | null) => void) | undefined;
    const source: WatchSource = (_root, l) => ((listener = l), { close: () => (listener = undefined) });
    const batches: WorkspaceChange[][] = [];
    const stop = watchWorkspace(root, (b) => batches.push(b), { debounceMs: 1, watch: source });
    try {
      atomicWrite(join(t.real, 'own', 'tests', 'a.yaml'), 'name: A\n'); // e.g. a real path made for the write (agents-md)
      expect(ownWrite(join(root, 'tests', 'a.yaml'))).toMatch(/^hash:/);
      atomicWrite(join(root, 'tests', 'b.yaml'), 'name: B\n');
      expect(ownWrite(join(t.real, 'own', 'tests', 'b.yaml'))).toMatch(/^hash:/);
      listener?.('change', join('tests', 'a.yaml'));
      await new Promise((r) => setTimeout(r, 50));
      expect(batches).toEqual([]);
    } finally {
      stop();
    }
  });

  it('the window hears of a write by the real path into the workspace it opened through the link', async () => {
    const root = join(t.dir, 'own');
    const ow = new OwnWrites(
      () => root,
      () => undefined,
    );
    try {
      let got: OwnWriteBatch | undefined;
      await ow.run(
        async () => atomicWrite(join(t.real, 'own', 'tests', 'c.yaml'), 'name: C\n'),
        (b) => (got = b),
      );
      expect(got).toEqual({ kinds: ['tests'], paths: ['tests/c.yaml'] });
    } finally {
      ow.dispose();
    }
  });
});

describe('the workspace list knows a folder by every name', () => {
  it('is listed once, deleted by either name, and a folder beside the data folder is not managed', () => {
    const app = new WorkspaceManager(join(t.dir, 'home'));
    const s = app.create('Linked', join(t.dir, 'linked'));
    s.close();
    app.rememberWorkspacePath(join(t.real, 'linked'));
    expect(app.loadSettings().workspacePaths).toEqual([join(t.dir, 'linked')]);
    expect(app.list().filter((w) => w.name === 'Linked')).toHaveLength(1);
    expect(app.isManaged(join(t.real, 'home', 'workspaces', 'x'))).toBe(true);
    expect(app.isManaged(join(t.dir, 'home', 'workspaces-old', 'x'))).toBe(false);
    expect(app.delete(join(t.real, 'linked'))).toEqual({ deletedFiles: false });
    expect(app.loadSettings().workspacePaths).toEqual([]);
  });
});

describe('git and CI through a link that is outside the repository', () => {
  it('the repository, its CI files and the pre-commit hook are those of the real folder', () => {
    const repo = join(t.real, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'jobs: {}\n');
    WorkspaceStore.create(join(repo, 'ws'), 'in-repo').close();
    const at = join(t.real, 'ws-link'); // beside the repository, not in it
    link(join(repo, 'ws'), at);
    expect(isInGitRepository(at)).toBe(true);
    expect(ciPipelineFiles(at).map((f) => f.replace(/\\/g, '/'))).toEqual([join(repo, '.github', 'workflows', 'ci.yml').replace(/\\/g, '/')]);
    const hook = installPreCommitHook(at, 'testpion');
    expect(hook.installed).toBe(true);
    expect(readFileSync(hook.path!, 'utf8')).toMatch(/^W='ws'$/m);
  });

  it('git status of a workspace opened through the link names its files inside the workspace', async () => {
    const ws = WorkspaceStore.create(join(t.dir, 'gitws'), 'gitws');
    ws.writeTestFile('smoke/health.yaml', FLOW);
    ws.close();
    await runGit(join(t.real, 'gitws'), ['init', '-b', 'main']);
    const st = await gitStatus(join(t.dir, 'gitws'));
    expect(st.folder).toBeUndefined();
    expect(st.files.map((f) => f.path)).toContain('tests/smoke/health.yaml');
  }, 60_000);
});

describe('CLI: a workspace given through a link, a file by its real path', () => {
  it('lint-tests names the file under tests/', () => {
    const ws = WorkspaceStore.create(join(t.dir, 'lint'), 'lint');
    ws.writeTestFile('smoke/bad.yaml', 'name: Bad\ntests:\n  - id: x\n    url: http://127.0.0.1:9/\n    method: FETCH\n');
    ws.close();
    const r = runCliSync(['lint-tests', join(t.real, 'lint', 'tests', 'smoke', 'bad.yaml'), '-w', join(t.dir, 'lint'), '--json'], { cwd: join(t.real, 'lint') });
    expect(cliData(r.out).results.map((x: { file: string }) => x.file)).toEqual(['smoke/bad.yaml']);
  }, 60_000);
});
