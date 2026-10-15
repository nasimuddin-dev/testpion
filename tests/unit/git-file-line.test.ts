import { describe, expect, it } from 'vitest';
import { parseItemRefUrl, itemRefUrl } from '@testpion/shared';
import { refTarget } from '../../apps/desktop/src/lib/ref-target';
import { diffRowOfLine } from '../../apps/desktop/src/lib/diff-line';

// A link to a changed file at a line (`git-file` with `line`) opens the Git view's diff at that line.
const DIFF = [
  'diff --git a/tests/a.yaml b/tests/a.yaml',
  'index 1111111..2222222 100644',
  '--- a/tests/a.yaml',
  '+++ b/tests/a.yaml',
  '@@ -1,4 +1,5 @@',
  ' tests:', // new line 1 (row 5)
  '-  - id: old', // removed (row 6)
  '+  - id: one', // 2 (row 7)
  '+    name: one', // 3 (row 8)
  '     type: http', // 4 (row 9)
  '     url: /a', // 5 (row 10)
  '@@ -20,3 +21,3 @@ tests:',
  '   - id: two', // 21 (row 12)
  '-    url: /b', // removed (row 13)
  '+    url: /c', // 22 (row 14)
  '\\ No newline at end of file',
].join('\n');

describe('git-file line', () => {
  it('the ref carries the line to the Git view as a number', () => {
    expect(refTarget({ kind: 'git-file', path: 'tests/a.yaml', line: '22' })).toMatchObject({ view: 'git', payload: { file: 'tests/a.yaml', line: 22 } });
    expect(refTarget({ kind: 'git-file', path: 'tests/a.yaml' })).toMatchObject({ view: 'git', payload: { file: 'tests/a.yaml' } });
    const url = itemRefUrl({ kind: 'git-file', path: 'tests/a.yaml', line: '22' });
    expect(parseItemRefUrl(url)).toEqual({ kind: 'git-file', path: 'tests/a.yaml', line: '22' });
  });

  it('finds the row of a new-version line: added and unchanged lines count, removed ones do not', () => {
    expect(diffRowOfLine(DIFF, 1)).toEqual({ row: 5, exact: true });
    expect(diffRowOfLine(DIFF, 2)).toEqual({ row: 7, exact: true });
    expect(diffRowOfLine(DIFF, 5)).toEqual({ row: 10, exact: true });
    expect(diffRowOfLine(DIFF, 21)).toEqual({ row: 12, exact: true });
    expect(diffRowOfLine(DIFF, 22)).toEqual({ row: 14, exact: true });
  });

  it('a line outside the hunks lands on the nearest hunk before it (else the first)', () => {
    expect(diffRowOfLine(DIFF, 10)).toEqual({ row: 4, exact: false });
    expect(diffRowOfLine(DIFF, 400)).toEqual({ row: 11, exact: false });
    expect(diffRowOfLine('@@ -9,2 +9,2 @@\n a\n b', 1)).toEqual({ row: 0, exact: false });
    expect(diffRowOfLine('', 3)).toBeUndefined();
    expect(diffRowOfLine('Binary files differ', 3)).toBeUndefined();
  });
});
