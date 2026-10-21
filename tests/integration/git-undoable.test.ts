import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitDiscard, gitResolve, undoJournal } from '@testpion/core';
import { journalFiles, journalResolve, restoreConflict, savedConflict } from '../../apps/desktop/backend/handlers/git-undoable';

/**
 * Undo for the two whole-file writes of the Changes panel and the conflict dialog (UX review): the journal that item
 * restores use takes a copy first, and a resolved file also gets its "both sides changed it" index entries back, so Undo
 * leaves a conflict again, not a modified file with conflict marks in it.
 */
let ws: string;
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], { cwd: ws, encoding: 'utf8' });

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), 'tp-undoable-'));
  git('init', '-q', '-b', 'main');
  writeFileSync(join(ws, 'a.txt'), 'one\nbase\nthree\n');
  writeFileSync(join(ws, 'keep.txt'), 'keep\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'theirs');
  writeFileSync(join(ws, 'a.txt'), 'one\ntheirs\nthree\n');
  git('commit', '-qam', 'theirs');
  git('checkout', '-q', 'main');
  writeFileSync(join(ws, 'a.txt'), 'one\nours\nthree\n');
  git('commit', '-qam', 'ours');
  try {
    git('merge', 'theirs');
  } catch {
    /* the conflict is the point */
  }
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));

describe('Undo of a whole-file resolve', () => {
  it('puts the file back as a conflict', async () => {
    expect(git('ls-files', '-u').trim().split('\n').length).toBe(3);
    const id = await journalResolve(ws, 'a.txt');
    expect(id).toBeTruthy();
    await gitResolve(ws, 'a.txt', 'theirs');
    expect(git('ls-files', '-u').trim()).toBe('');
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toContain('theirs');
    const stages = savedConflict(ws, id);
    expect(stages).toBeTruthy();
    undoJournal(ws, id);
    await restoreConflict(ws, stages!);
    // three entries again (the common ancestor, ours, theirs), and the file as it was with the conflict marks
    expect(git('ls-files', '-u').trim().split('\n').length).toBe(3);
    expect(git('status', '--porcelain')).toMatch(/^UU a\.txt/m);
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toContain('<<<<<<<');
  });
});

describe('Undo of a whole-file discard', () => {
  it('puts back a changed file and a new one', async () => {
    // settle the merge first so the next changes are plain ones
    writeFileSync(join(ws, 'a.txt'), 'one\nmerged\nthree\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'merge');
    writeFileSync(join(ws, 'keep.txt'), 'edited\n');
    writeFileSync(join(ws, 'fresh.txt'), 'new file\n');
    const id = journalFiles(ws, 'discard', 'Discard changes to 2 files', ['keep.txt', 'fresh.txt']);
    expect(id).toBeTruthy();
    await gitDiscard(ws, [
      { path: 'keep.txt', state: 'modified' },
      { path: 'fresh.txt', state: 'untracked' },
    ]);
    // (git on Windows may write the line endings it is configured to)
    expect(readFileSync(join(ws, 'keep.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('keep\n');
    expect(existsSync(join(ws, 'fresh.txt'))).toBe(false);
    undoJournal(ws, id);
    expect(readFileSync(join(ws, 'keep.txt'), 'utf8')).toBe('edited\n');
    expect(readFileSync(join(ws, 'fresh.txt'), 'utf8')).toBe('new file\n');
  });

  it('copies nothing for a path that is not a file (a folder, a file already gone)', () => {
    expect(journalFiles(ws, 'discard', 'nothing', ['no-such-file.txt', '.'])).toBeUndefined();
  });
});
