import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRIVATE_FILE_MODE, atomicWrite } from '../../packages/core/src/index.js';
import { restrictToOwner, setAclTestHooks } from '../../packages/core/src/storage/private-acl.js';

afterEach(() => setAclTestHooks());

describe('owner-only ACLs on Windows (the counterpart of 0600 / 0700)', () => {
  it('icacls gets an argument array: inheritance removed, one entry for this user, inherited by what the folder holds', () => {
    const calls: Array<[string, string[]]> = [];
    setAclTestHooks({ platform: 'win32', user: 'HOME\\me', runner: (f, a) => calls.push([f, a]) });
    expect(restrictToOwner('C:\\Users\\me\\.testpion', 'dir')).toBe(true);
    expect(restrictToOwner('C:\\Users\\me\\.testpion\\secrets.json', 'file')).toBe(true);
    expect(calls).toEqual([
      ['icacls', ['C:\\Users\\me\\.testpion', '/inheritance:r', '/grant:r', 'HOME\\me:(OI)(CI)F']],
      ['icacls', ['C:\\Users\\me\\.testpion\\secrets.json', '/inheritance:r', '/grant:r', 'HOME\\me:F']],
    ]);
  });

  it('runs once per path, never on another platform, and a failure is never fatal', () => {
    const calls: string[] = [];
    setAclTestHooks({ platform: 'win32', user: 'me', runner: (_f, a) => (calls.push(a[0]!), (() => { throw new Error('Access is denied'); })()) });
    expect(restrictToOwner('C:\\a', 'dir')).toBe(false);
    expect(restrictToOwner('C:\\a', 'dir')).toBe(false);
    expect(calls).toEqual(['C:\\a']);
    setAclTestHooks({ platform: 'linux', user: 'me', runner: () => calls.push('never') });
    expect(restrictToOwner('/a', 'dir')).toBe(false);
    expect(calls).toEqual(['C:\\a']);
  });

  it('a private write restricts its folder and its file, an ordinary write does not', () => {
    const calls: string[] = [];
    setAclTestHooks({ platform: 'win32', user: 'me', runner: (_f, a) => calls.push(a[0]!) });
    const dir = mkdtempSync(join(tmpdir(), 'tp-acl-'));
    atomicWrite(join(dir, 'plain.json'), '{}');
    expect(calls).toEqual([]);
    atomicWrite(join(dir, 'secrets.json'), '{}', { mode: PRIVATE_FILE_MODE });
    expect(calls).toEqual([dir, join(dir, 'secrets.json')]);
    atomicWrite(join(dir, 'secrets.json'), '{"a":1}', { mode: PRIVATE_FILE_MODE });
    expect(calls).toHaveLength(2); // once per path
  });
});
