import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// a scripted repository per run, one merge per kind: slow machines (CI, parallel runs) need room
vi.setConfig({ testTimeout: 300_000, hookTimeout: 180_000 });
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIND_INFO, gitSectionKey, liveKinds, type ItemKindInfo } from '@testpion/shared';
import { addressOf, canonicalText, describeGitChanges, discardItem, gitAbortMerge, gitConflictDetail, gitStatus, itemHistory, runGit, stageItem } from '../../packages/core/src/index.js';
import { makeRepo, type TestRepo } from '../helpers-git';

/**
 * The full-registry gap matrix of "Everything under Git" (planning/git-everything.md §4j): every kind the registry says is
 * `versioned` has, in the engine, a stable form (or is a document kept as written), a row in the Git view with its kind and
 * ref (what the marks are made from), a history, Discard, Stage and a conflict screen, and the registry grants the four git
 * capabilities. A kind added without one of them fails here, with the kind's name. The window's rows are checked by the marks
 * test (git-marks.test.ts); the secret scan of each kind by git-staged-secrets.test.ts.
 */
const versioned = liveKinds().filter((k) => k.capabilities.versioned === true);
/** A kind stored as its base kind (a flow is a test file); a request and a folder are the collection's. */
const ownStorage = versioned.filter((k) => !k.variantOf);

let r: TestRepo;
beforeAll(async () => {
  r = await makeRepo();
});
afterAll(() => r.cleanup());

const pathOf = (k: ItemKindInfo): string => k.sample ?? KIND_INFO[k.variantOf!].sample!;

/** The file with one thing changed, tagged: a JSON file's first name (or a top-level key), a document gets a comment line. */
function mutate(path: string, text: string, tag: string): string {
  if (/\.json$/i.test(path)) {
    const doc = JSON.parse(text.replace(/^﻿/, '')) as unknown;
    let done = false;
    const walk = (v: unknown) => {
      if (done || !v || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      if (!Array.isArray(v) && typeof o.name === 'string') {
        o.name = `${o.name} ${tag}`;
        done = true;
        return;
      }
      for (const x of Object.values(o)) walk(x);
    };
    walk(doc);
    if (!done) (doc as Record<string, unknown>).note = tag;
    return JSON.stringify(doc, null, 2) + '\n';
  }
  if (/\.csv$/i.test(path)) return `${text.trimEnd()}\n${tag},1\n`;
  return `# ${tag}\n${text}`;
}

describe('the registry grants the git capabilities to every versioned kind', () => {
  it('git-history, git-discard, git-stage and secret-scan are true; a request and a folder are versioned with their collection', () => {
    for (const k of [...versioned, KIND_INFO.request, KIND_INFO.folder])
      for (const cap of ['git-history', 'git-discard', 'git-stage', 'secret-scan'] as const) expect(k.capabilities[cap], `${k.id}.${cap}`).toBe(true);
  });

  it('the kinds now versioned by release C', () => {
    for (const id of ['workspace', 'proto', 'script-package', 'mcp-mock', 'debugger-rules', 'rag-target'] as const) expect(KIND_INFO[id].capabilities.versioned, id).toBe(true);
    // capture sessions stay on this computer on purpose; Share session copies one
    expect(KIND_INFO.capture.capabilities.versioned).toMatchObject({ na: expect.stringContaining('Share session') });
  });
});

describe('every versioned kind, in a scripted repository', () => {
  it('the walk finds the kinds (a registry that lost them would pass every loop below)', () => {
    expect(ownStorage.map((k) => k.id)).toEqual(
      expect.arrayContaining([
        'collection',
        'environment',
        'workspace',
        'test',
        'spec',
        'dataset',
        'proto',
        'script-package',
        'mcp-server',
        'mcp-mock',
        'provider',
        'prompt',
        'load-test',
        'evaluation',
        'monitor',
        'rag-target',
        'grpc-call',
        'ws-connection',
        'debugger-rules',
      ]),
    );
  });

  it('has a stable form (JSON kinds) or is a document kept as written, and git merges it', () => {
    for (const k of ownStorage) {
      const path = pathOf(k);
      const text = readFileSync(join(r.ws, path), 'utf8');
      const canon = canonicalText(path, text);
      if (canon === undefined) expect(k.storage.layout, `${k.id}: no stable form and not a raw document`).toBe('raw-document');
      else expect(canonicalText(path, canon), `${k.id}: the stable form is not stable`).toBe(canon);
      expect(k.git.merge, k.id).not.toBe('none');
    }
  });

  it("shows a change as a row of the Git view with its kind and ref (the marks are made from them), in its kind's section", async () => {
    for (const k of ownStorage) {
      const path = pathOf(k);
      r.write(path, mutate(path, r.read(path), 'marks'));
      const st = await gitStatus(r.ws);
      const rows = await describeGitChanges(
        r.ws,
        st.files.filter((f) => f.path === path),
      );
      expect(rows.length, `${k.id}: no row for a change to ${path}`).toBeGreaterThan(0);
      expect(
        rows.every((c) => c.kindId && c.ref),
        `${k.id}: a row has no kind or ref: ${JSON.stringify(rows[0])}`,
      ).toBe(true);
      // the section of the kind (or of its base kind: a call is in its collection) counts it
      const sections = new Set(rows.flatMap((c) => c.containers ?? []));
      const wanted = [k.id, k.variantOf, k.parent].filter(Boolean).map((id) => gitSectionKey(id as never));
      expect(wanted.some((w) => sections.has(w)) || [...sections].some((s) => s.startsWith('section|')), `${k.id}: the change is in no section (${[...sections].join(', ')})`).toBe(true);
      await r.git('checkout', '--', path);
    }
  });

  it('has a history, Discard and Stage', async () => {
    for (const k of ownStorage) {
      const path = pathOf(k);
      const a = addressOf(path);
      // history: the base commit and one change
      r.write(path, mutate(path, r.read(path), 'v2'));
      await r.git('add', '--', path);
      await r.git('commit', '-q', '-m', `${k.id} v2`);
      const h = await itemHistory(r.ws, a);
      expect(h.versions.length, `${k.id}: history`).toBe(2);
      expect(h.versions[0]!.commit.subject).toBe(`${k.id} v2`);
      // discard: a change that is not committed goes back to the last commit
      const committed = r.read(path);
      r.write(path, mutate(path, committed, 'draft'));
      const dry = await discardItem(r.ws, a, { dryRun: true });
      expect(dry.changed, `${k.id}: discard sees the change`).toBe(true);
      const res = await discardItem(r.ws, a);
      expect(res.applied, `${k.id}: discard`).toBe(true);
      expect(r.read(path).replace(/\r\n/g, '\n'), `${k.id}: discard restores the file`).toBe(committed.replace(/\r\n/g, '\n'));
      // stage: the change is in the index
      r.write(path, mutate(path, committed, 'staged'));
      const st = await stageItem(r.ws, a);
      expect(st.applied, `${k.id}: stage`).toBe(true);
      expect((await runGit(r.ws, ['diff', '--cached', '--name-only'])).split('\n'), `${k.id}: staged`).toContain(path);
      await r.git('reset', '-q', '--hard', 'HEAD');
    }
  });

  it('has a conflict screen: the same thing changed on both sides is a conflict the app can read', async () => {
    for (const k of ownStorage) {
      const path = pathOf(k);
      const base = r.read(path);
      await r.git('checkout', '-q', '-b', 'theirs');
      r.write(path, mutate(path, base, 'theirs'));
      await r.git('commit', '-q', '-am', 'theirs');
      await r.git('checkout', '-q', 'main');
      r.write(path, mutate(path, base, 'ours'));
      await r.git('commit', '-q', '-am', 'ours');
      await r.git('merge', 'theirs').catch(() => undefined);
      const st = await gitStatus(r.ws);
      expect(st.files.find((f) => f.path === path)?.state, `${k.id}: the merge did not stop on ${path}`).toBe('conflicted');
      const d = await gitConflictDetail(r.ws, path);
      expect(['items', 'text', 'binary'], `${k.id}: conflict mode ${d.mode}`).toContain(d.mode);
      expect(d.items.length + d.hunks.length + (d.mode === 'binary' ? 1 : 0), `${k.id}: nothing to resolve in the conflict screen`).toBeGreaterThan(0);
      await gitAbortMerge(r.ws);
      await r.git('reset', '-q', '--hard', 'HEAD~1');
      await r.git('branch', '-q', '-D', 'theirs');
    }
  });
});
