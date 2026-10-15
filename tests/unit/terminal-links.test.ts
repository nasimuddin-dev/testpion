import { describe, it, expect } from 'vitest';
import { refOfTerminalPath, terminalLinks } from '../../apps/desktop/src/lib/terminal-links.js';
import { refTarget } from '../../apps/desktop/src/lib/ref-target.js';
import { itemRefUrl, parseItemRefUrl, toItemRef } from '../../packages/shared/src/item-ref.js';

// File links in the Terminal: what a command prints as a path opens that item through openRef.
describe('terminal file links', () => {
  it('a workspace path opens what it is, at the line', () => {
    expect(refOfTerminalPath('tests/smoke.yaml', undefined, 12)).toEqual({ kind: 'test', path: 'smoke.yaml', line: '12' });
    expect(refOfTerminalPath('tests\\api\\users.test.yaml')).toEqual({ kind: 'test', path: 'api/users.test.yaml' });
    expect(refOfTerminalPath('./specs/petstore.yaml', undefined, 3)).toEqual({ kind: 'spec', path: 'specs/petstore.yaml' });
    expect(refOfTerminalPath('datasets/users.csv')).toEqual({ kind: 'dataset', name: 'users.csv' });
    expect(refOfTerminalPath('collections/c-123.json')).toEqual({ kind: 'collection', collectionId: 'c-123' });
    expect(refOfTerminalPath('environments/dev.json', undefined, 4)).toEqual({ kind: 'git-file', path: 'environments/dev.json', line: '4' });
  });

  it('absolute paths count only inside the workspace folder; nothing outside it is a link', () => {
    expect(refOfTerminalPath('C:\\Work\\ws\\tests\\a.yaml', 'C:\\Work\\ws', 7)).toEqual({ kind: 'test', path: 'a.yaml', line: '7' });
    expect(refOfTerminalPath('c:/work/WS/tests/a.yaml', 'C:\\Work\\ws')).toEqual({ kind: 'test', path: 'a.yaml' });
    expect(refOfTerminalPath('/home/me/ws/specs/x.json', '/home/me/ws')).toEqual({ kind: 'spec', path: 'specs/x.json' });
    expect(refOfTerminalPath('/home/me/WS/specs/x.json', '/home/me/ws')).toBeUndefined();
    expect(refOfTerminalPath('C:\\Windows\\System32\\cmd.exe', 'C:\\Work\\ws')).toBeUndefined();
    expect(refOfTerminalPath('/etc/passwd.txt')).toBeUndefined();
    expect(refOfTerminalPath('../other/tests/a.yaml')).toBeUndefined();
    expect(refOfTerminalPath('tests/../../x/a.yaml')).toBeUndefined();
  });

  it('finds the links in a line of output, with their columns and the :line', () => {
    const line = '  ✗ login fails  tests/auth/login.yaml:14:3  (see specs/api.yaml)';
    const links = terminalLinks(line);
    expect(links.map((l) => [l.text, line.slice(l.start, l.start + l.length)])).toEqual([
      ['tests/auth/login.yaml:14:3', 'tests/auth/login.yaml:14:3'],
      ['specs/api.yaml', 'specs/api.yaml'],
    ]);
    expect(links[0]!.ref).toEqual({ kind: 'test', path: 'auth/login.yaml', line: '14' });
    // versions, plain words and URLs are not file links
    expect(terminalLinks('TestPion 0.45.0 at https://testpion.dev/docs/a.html and 1.2.3/4.5')).toEqual([]);
    expect(terminalLinks('PS C:\\Work\\ws> testpion run tests\\smoke.yaml', 'C:\\Work\\ws').map((l) => l.ref)).toEqual([{ kind: 'test', path: 'smoke.yaml' }]);
  });

  it('a line travels with the ref (links, deep links) to the view that opens it', () => {
    const ref = toItemRef({ kind: 'test', path: 'a.yaml', line: '9' })!;
    expect(parseItemRefUrl(itemRefUrl(ref))).toEqual(ref);
    expect(refTarget(ref)).toEqual({ view: 'tests', payload: { path: 'a.yaml', line: 9 } });
    expect(refTarget({ kind: 'git-file', path: 'x/y.json', line: '2' })).toEqual({ view: 'git', payload: { file: 'x/y.json', line: 2 } });
  });
});
