import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ownersOf, ownershipOf, parseCodeowners, workspaceCodeowners } from '../../packages/core/src/index.js';
import { makeRepo, type TestRepo } from '../helpers-git';

describe('owners of an item (CODEOWNERS and the last change)', () => {
  it('parses rules and matches the last one, as GitHub does: anchored, directory, bare name, * and **', () => {
    const rules = parseCodeowners(['# comment', '*  @org/all', '/collections/  @org/api @ana', 'environments/  @org/ops', 'tests/**/*.yaml @org/qa', 'payments.json @org/payments', ''].join('\n'));
    expect(rules).toHaveLength(5);
    expect(ownersOf(rules, 'collections/payments.json')).toEqual(['@org/payments']);
    expect(ownersOf(rules, 'collections/users.json')).toEqual(['@org/api', '@ana']);
    expect(ownersOf(rules, 'environments/staging.json')).toEqual(['@org/ops']);
    expect(ownersOf(rules, 'tests/smoke/login.yaml')).toEqual(['@org/qa']);
    expect(ownersOf(rules, 'README.md')).toEqual(['@org/all']);
    expect(ownersOf([], 'anything')).toEqual([]);
  });

  describe('in a repository', () => {
    let r: TestRepo;
    beforeAll(async () => {
      r = await makeRepo();
    });
    afterAll(() => r.cleanup());

    it('reads the repository CODEOWNERS, names the owners of a workspace file, and who last changed it', async () => {
      expect(await workspaceCodeowners(r.ws)).toBeUndefined();
      mkdirSync(join(r.repo, '.github'), { recursive: true });
      writeFileSync(join(r.repo, '.github', 'CODEOWNERS'), '/environments/ @org/ops\n/collections/ @org/api\n');
      const co = await workspaceCodeowners(r.ws);
      expect(co?.rules.map((x) => x.owners)).toEqual([['@org/ops'], ['@org/api']]);
      r.write('collections/owned.json', '{"schemaVersion":"1.0","id":"owned","name":"Owned","version":0,"variables":[],"items":[],"updatedAt":""}');
      await r.commit('Add the owned collection');
      const o = await ownershipOf(r.ws, 'collections/owned.json');
      expect(o.owners).toEqual(['@org/api']);
      expect(o.lastChange?.subject).toBe('Add the owned collection');
      expect(o.lastChange?.author).toBeTruthy();
      const none = await ownershipOf(r.ws, 'tests/nothing.yaml');
      expect(none).toEqual({ file: 'tests/nothing.yaml', owners: [] });
    });
  });
});
