import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { onboardingProgress, WorkspaceStore } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// WF-22 Get started follows the first loop (send → save → save as test → run → CI), ticked from what the workspace holds.
const tmp = tempDir('tp-onboarding-');
afterAll(() => tmp.cleanup());

describe('onboarding progress', () => {
  it('each step is done from the workspace, and names what its button opens', () => {
    const repo = join(tmp.dir, 'repo');
    const s = WorkspaceStore.create(join(repo, 'api-tests'), 'Fresh');
    const ids = (st: ReturnType<typeof onboardingProgress>) => st.map((x) => `${x.id}:${x.done ? 'done' : 'todo'}`).join(' ');
    expect(ids(onboardingProgress(s))).toBe('send:todo save:todo test:todo run:todo ci:todo');
    s.saveCollection({
      schemaVersion: '1.0',
      id: 'c1',
      name: 'API',
      version: 0,
      updatedAt: '',
      variables: [],
      items: [{ kind: 'folder', id: 'f', name: 'F', items: [{ kind: 'http', id: 'r1', name: 'Health', request: { method: 'GET', url: '/h' } }] }],
    } as never);
    mkdirSync(join(s.root, 'tests', 'smoke'), { recursive: true });
    writeFileSync(join(s.root, 'tests', 'smoke', 'health.yaml'), 'tests: []\n');
    let st = onboardingProgress(s);
    expect(ids(st)).toBe('send:todo save:done test:done run:todo ci:todo');
    expect(st.find((x) => x.id === 'save')?.ref).toEqual({ kind: 'request', collectionId: 'c1', requestId: 'r1' });
    expect(st.find((x) => x.id === 'run')?.ref).toEqual({ kind: 'test', path: 'smoke/health.yaml' });
    // a pipeline in the repository above the workspace that runs testpion
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'jobs:\n  t:\n    steps:\n      - run: node "$TESTPION_CLI" test api-tests/tests\n');
    st = onboardingProgress(s);
    expect(st.find((x) => x.id === 'ci')?.done).toBe(true);
    s.close();
  });
});
