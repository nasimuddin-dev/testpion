import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { ItemRef } from '@testpion/shared';
import type { CollectionNode } from '../model/types.js';
import type { WorkspaceStore } from './workspace.js';

/** One step of the first loop: explore → save → test → CI (planning/workflow-ux.md §2, loop a). */
export interface OnboardingStep {
  id: 'send' | 'save' | 'test' | 'run' | 'ci';
  done: boolean;
  /** What the step's button opens (the latest of the thing the step builds on), when there is one. */
  ref?: ItemRef;
}

const firstRequest = (nodes: CollectionNode[]): string | undefined => {
  for (const n of nodes) {
    if (n.kind !== 'folder') return n.id;
    const f = firstRequest(n.items);
    if (f) return f;
  }
  return undefined;
};

/** The first test file under tests/ (breadth first, at most `budget` entries read). */
function firstTestFile(dir: string, budget = 400): string | undefined {
  const queue = [dir];
  let seen = 0;
  while (queue.length && seen < budget) {
    const d = queue.shift()!;
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > budget) break;
      const p = join(d, e);
      if (/\.(ya?ml|json)$/i.test(e) && !/\.suite\./i.test(e)) return relative(dir, p).split(sep).join('/');
      try {
        if (statSync(p).isDirectory() && !e.startsWith('.')) queue.push(p);
      } catch {
        /* gone */
      }
    }
  }
  return undefined;
}

/** A CI pipeline that runs testpion: GitHub, GitLab, Azure or Jenkins, in the workspace folder or a repository above it (3 levels). */
function hasPipeline(root: string): boolean {
  const runsTestpion = (f: string) => {
    try {
      return statSync(f).size < 512_000 && /testpion/i.test(readFileSync(f, 'utf8'));
    } catch {
      return false;
    }
  };
  let dir = root;
  for (let i = 0; i < 4; i++) {
    const wf = join(dir, '.github', 'workflows');
    if (existsSync(wf)) {
      try {
        if (readdirSync(wf).some((f) => /\.ya?ml$/.test(f) && runsTestpion(join(wf, f)))) return true;
      } catch {
        /* unreadable */
      }
    }
    if (['.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile'].some((f) => runsTestpion(join(dir, f)))) return true;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}

/**
 * WF-22 Home's Get started, from what the workspace holds (never from clicks): a request sent (History), a request saved
 * in a collection, a test file, a run, a CI pipeline that runs testpion. Each step names what its button opens.
 */
export function onboardingProgress(store: WorkspaceStore): OnboardingStep[] {
  const sent = store.meta.listHistory({ limit: 1 }).items[0];
  let saved: ItemRef | undefined;
  for (const c of store.listCollections()) {
    if ((c as { problem?: string }).problem) continue;
    const id = firstRequest(c.items ?? []);
    if (id) {
      saved = { kind: 'request', collectionId: c.id, requestId: id };
      break;
    }
  }
  const test = firstTestFile(store.path('tests'));
  const run = store.meta.listRuns({ limit: 1 }).items[0];
  return [
    { id: 'send', done: !!sent, ...(sent ? { ref: { kind: 'history', historyId: sent.id } } : {}) },
    { id: 'save', done: !!saved, ...(saved ? { ref: saved } : sent ? { ref: { kind: 'history', historyId: sent.id } } : {}) },
    { id: 'test', done: !!test, ...(test ? { ref: { kind: 'test', path: test } } : saved ? { ref: saved } : {}) },
    { id: 'run', done: !!run, ...(run ? { ref: { kind: 'run', runId: run.id } } : test ? { ref: { kind: 'test', path: test } } : {}) },
    { id: 'ci', done: hasPipeline(store.root), ...(test ? { ref: { kind: 'test', path: test } } : {}) },
  ];
}
