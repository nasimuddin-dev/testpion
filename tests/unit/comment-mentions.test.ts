import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mentionsIn, mentionsPerson } from '../../packages/shared/src/index.js';
import { addComment, openCommentsByOwner, WorkspaceStore } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// @mentions in comments for your team: `@Ana`, `@ana.lee`, `@org/payments`; the comments that mention you come first on
// Home ("For you") and `testpion item comment open --for-me` lists them.
const tmp = tempDir('tp-mentions-');
afterAll(() => tmp.cleanup());

describe('mentions in comments', () => {
  it('finds @names, not e-mail addresses, each once', () => {
    expect(mentionsIn('@Ana can you check this? cc @org/payments, and @ana again.')).toEqual(['Ana', 'org/payments']);
    expect(mentionsIn('write to ana@example.com')).toEqual([]);
    expect(mentionsIn('(@ana.lee) and @bob.')).toEqual(['ana.lee', 'bob']);
    // any script: a name the repository's history suggests is matched as it is written
    expect(mentionsIn('@JoséGarcía and @ŁukaszNowak, cc @李雷')).toEqual(['JoséGarcía', 'ŁukaszNowak', '李雷']);
    expect(mentionsPerson(['JoséGarcía'], { name: 'José García' })).toBe(true);
  });

  it('names a person by git name, first name or the e-mail before the @ (a no-reply login too)', () => {
    const ana = { name: 'Ana Lee', email: '12345+analee@users.noreply.github.com' };
    expect(mentionsPerson(['AnaLee'], ana)).toBe(true);
    expect(mentionsPerson(['ana'], ana)).toBe(true);
    expect(mentionsPerson(['analee'], ana)).toBe(true);
    expect(mentionsPerson(['bob'], ana)).toBe(false);
    expect(mentionsPerson(['ana'], {})).toBe(false);
  });

  it('open comments carry their mentions and say which are for the person asking (or a team they name)', async () => {
    const s = WorkspaceStore.create(join(tmp.dir, 'ws'), 'Mentions');
    try {
      const ref = { kind: 'environment', environmentId: 'development' } as const;
      addComment(s, ref, 'Is the base URL right, @Ana?', 'Bob');
      addComment(s, ref, 'Payments: please own this @org/payments', 'Bob');
      addComment(s, ref, 'Nothing for anyone', 'Bob');
      const open = await openCommentsByOwner(s, undefined, { name: 'Ana Lee', email: 'ana@example.com', teams: ['@org/payments'] });
      expect(open.map((c) => [c.text.slice(0, 12), c.mentions, !!c.forYou]).sort()).toEqual(
        [
          ['Is the base ', ['Ana'], true],
          ['Nothing for ', [], false],
          ['Payments: pl', ['org/payments'], true],
        ].sort(),
      );
    } finally {
      s.close();
    }
  });
});

describe('who a comment can mention', () => {
  it('the people of the repository history and the teams of CODEOWNERS, each once', async () => {
    const { makeRepo } = await import('../helpers-git');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { mentionCandidates } = await import('../../packages/core/src/index.js');
    const r = await makeRepo();
    try {
      r.write('notes.txt', 'one');
      await r.commit('First');
      mkdirSync(join(r.repo, '.github'), { recursive: true });
      writeFileSync(join(r.repo, '.github', 'CODEOWNERS'), '* @org/api\n/collections/ @org/payments @org/api\n');
      const people = await mentionCandidates({ root: r.ws });
      expect(people.filter((p) => p.kind === 'person').map((p) => [p.handle, p.label])).toEqual([['Tester', 'Tester']]);
      expect(people.filter((p) => p.kind === 'team').map((p) => p.label)).toEqual(['@org/api', '@org/payments']);
    } finally {
      r.cleanup();
    }
  });
});
