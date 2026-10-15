import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flowLoadFile, isInside, realPathOf, relativeInside, testFileRef, WorkspaceStore } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// A workspace opened through a linked folder (macOS names its temp folders /var → /private/var and /tmp → /private/tmp;
// a junction or a linked home folder elsewhere) is still itself: the paths that guard writes compare real paths on
// both sides, so a path named the other way (the real one, from the current folder or a link's target) is inside.
const tmp = tempDir('tp-linked-ws-');
afterAll(() => tmp.cleanup());

const linkKind = process.platform === 'win32' ? 'junction' : 'dir';
const real = join(tmp.dir, 'real');
mkdirSync(join(real, 'ws'), { recursive: true });
const link = join(tmp.dir, 'link');
symlinkSync(real, link, linkKind);
const outside = join(tmp.dir, 'outside');
mkdirSync(outside);

describe('relativeInside', () => {
  it('is inside named either way, as given or really; outside is outside', () => {
    const viaLink = join(link, 'ws');
    const viaReal = join(realpathSync(real), 'ws');
    expect(relativeInside(viaLink, join(viaReal, 'tests', 'a.yaml'))).toBe(join('tests', 'a.yaml'));
    expect(relativeInside(viaReal, join(viaLink, 'tests', 'a.yaml'))).toBe(join('tests', 'a.yaml'));
    expect(relativeInside(viaLink, viaReal)).toBeUndefined();
    expect(relativeInside(viaLink, viaReal, { orSame: true })).toBe('');
    expect(isInside(viaLink, join(outside, 'x'))).toBe(false);
    expect(isInside(viaLink, join(viaLink, '..', 'x'))).toBe(false);
    // a name that starts with two dots is a name, not the folder above
    expect(relativeInside(viaLink, join(viaLink, '..hidden'))).toBe('..hidden');
  });

  it('realPathOf: a file not written yet is where its folder really is', () => {
    expect(realPathOf(join(link, 'ws', 'new', 'file.md'))).toBe(join(realpathSync(real), 'ws', 'new', 'file.md'));
  });

  it.runIf(process.platform === 'win32')('Windows paths ignore case', () => {
    expect(isInside(join(link, 'ws').toUpperCase(), join(link, 'ws', 'a.yaml').toLowerCase())).toBe(true);
  });
});

describe('a workspace opened through a link', () => {
  it('safePath takes its files by their real path (named the way the workspace names them) and still refuses the rest', () => {
    const s = WorkspaceStore.create(join(link, 'ws', 'w1'), 'Linked');
    try {
      const realTests = join(realpathSync(s.root), 'tests');
      writeFileSync(join(realTests, 'a.yaml'), 'tests: []\n');
      expect(s.safePath(join(realTests, 'a.yaml'), s.path('tests'))).toBe(join(s.root, 'tests', 'a.yaml'));
      expect(s.safePath(realpathSync(s.root))).toBe(s.root);
      expect(() => s.safePath('../escape.yaml')).toThrow(/escapes the workspace/);
      expect(() => s.safePath(join(outside, 'x.yaml'))).toThrow(/escapes the workspace/);
      // a test file named from the current folder (a real path) is the file under tests/
      expect(testFileRef(s, join(realTests, 'a.yaml'))).toBe('a.yaml');
      expect(flowLoadFile(join(realTests, 'a.yaml'), s.path('tests'))).toBe(join(realTests, 'a.yaml'));
      expect(() => flowLoadFile(join(outside, 'a.yaml'), s.path('tests'))).toThrow(/inside tests/);
    } finally {
      s.close();
    }
  });
});
