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

  it("matches GitHub's documented examples", () => {
    // the example file of GitHub's "About code owners", in its order
    const rules = parseCodeowners(
      [
        '# This is a comment.',
        '*       @global-owner1 @global-owner2',
        '*.js    @js-owner #This is an inline comment.',
        '*.go docs@example.com',
        '*.txt @octo-org/octocats',
        '/build/logs/ @doctocat',
        'docs/*  docs@example.com',
        'apps/ @octocat',
        '/docs/ @doctocat',
        '/scripts/ @doctocat @octocat',
        '**/logs @octocat',
        '/apps/ @octocat',
        '/apps/github',
        '/apps/ @octocat',
        '/apps/github @doctocat',
      ].join('\n'),
    );
    expect(rules).toHaveLength(14);
    expect(rules[1]).toEqual({ pattern: '*.js', owners: ['@js-owner'] });
    expect(rules[11]).toEqual({ pattern: '/apps/github', owners: [] });
    const cases: Array<[string, string[]]> = [
      ['README.md', ['@global-owner1', '@global-owner2']],
      ['src/deep/app.js', ['@js-owner']],
      ['cmd/main.go', ['docs@example.com']],
      ['notes/todo.txt', ['@octo-org/octocats']],
      // a later rule that matches wins: two stars then /logs comes after /build/logs/
      ['build/logs/today.txt', ['@octocat']],
      ['other/build/logs/x.md', ['@octocat']],
      // docs/* : the files in docs, not the ones in a folder below
      ['docs/getting-started.md', ['@doctocat']],
      ['docs/build-app/troubleshooting.md', ['@doctocat']],
      ['scripts/run.sh', ['@doctocat', '@octocat']],
      // two stars then /logs: a logs folder at any depth, the root included
      ['logs/a.log', ['@octocat']],
      ['deeply/nested/logs/a.log', ['@octocat']],
      // apps/ : an apps folder anywhere
      ['packages/apps/x.md', ['@octocat']],
      ['apps/web/index.md', ['@octocat']],
      ['apps/github/index.md', ['@doctocat']],
    ];
    for (const [path, owners] of cases) expect([path, ownersOf(rules, path)]).toEqual([path, owners]);
    // /build/logs/ is the folder at the root only (the rules up to it)
    expect(ownersOf(rules.slice(0, 5), 'build/logs/today.md')).toEqual(['@doctocat']);
    expect(ownersOf(rules.slice(0, 5), 'other/build/logs/today.md')).toEqual(['@global-owner1', '@global-owner2']);
    // /apps/github without owners, as the last rule that matches: nobody owns it
    expect(ownersOf(rules.slice(0, 12), 'apps/github/index.md')).toEqual([]);
  });

  it('a last segment * is the direct children only; two stars match no folder too; escaped spaces stay in the pattern', () => {
    const rules = parseCodeowners(['/tests/* @direct', 'docs/* @docs', '**/gen @gen', 'a/**/b @ab', 'lib/** @lib', 'path\\ with\\ spaces/ @spaces', '\\#notes.md @hash', 'file.[ab] @literal'].join('\n'));
    expect(rules.map((r) => r.pattern)).toEqual(['/tests/*', 'docs/*', '**/gen', 'a/**/b', 'lib/**', 'path\\ with\\ spaces/', '\\#notes.md', 'file.[ab]']);
    expect(ownersOf(rules, 'tests/smoke.yaml')).toEqual(['@direct']);
    expect(ownersOf(rules, 'tests/smoke/login.yaml')).toEqual([]);
    expect(ownersOf(rules, 'x/tests/smoke.yaml')).toEqual([]);
    expect(ownersOf(rules, 'docs/a.md')).toEqual(['@docs']);
    expect(ownersOf(rules, 'docs/guide/a.md')).toEqual([]);
    expect(ownersOf(rules, 'gen')).toEqual(['@gen']);
    expect(ownersOf(rules, 'gen/x.ts')).toEqual(['@gen']);
    expect(ownersOf(rules, 'src/gen/x.ts')).toEqual(['@gen']);
    expect(ownersOf(rules, 'a/b')).toEqual(['@ab']);
    expect(ownersOf(rules, 'a/x/y/b/file.ts')).toEqual(['@ab']);
    expect(ownersOf(rules, 'ab')).toEqual([]);
    expect(ownersOf(rules, 'lib/x/y.ts')).toEqual(['@lib']);
    expect(ownersOf(rules, 'path with spaces/file.md')).toEqual(['@spaces']);
    expect(ownersOf(rules, 'path/file.md')).toEqual([]);
    expect(ownersOf(rules, '#notes.md')).toEqual(['@hash']);
    // character ranges are not patterns in CODEOWNERS: the brackets are themselves
    expect(ownersOf(rules, 'file.a')).toEqual([]);
    expect(ownersOf(rules, 'file.[ab]')).toEqual(['@literal']);
    // the same rules asked again (the compiled patterns are reused) answer the same
    expect(ownersOf(rules, 'tests/smoke.yaml')).toEqual(['@direct']);
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
