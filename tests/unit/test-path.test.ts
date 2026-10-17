/**
 * A test file path from outside (an AI proposal's target, an agent's write_test_file) gets the same answer on every OS.
 * node:path answers per OS — `C:\x.yaml` is absolute on Windows and a file name on Linux and macOS — so the check is
 * lexical; the table below runs unchanged on all three CI runners, and `path.posix` / `path.win32` show the cases where
 * the two disagree (the ones that used to pass on Linux and macOS).
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkedTestFilePath, MAX_TEST_PATH, realTestFilePath, relativeTestFilePath } from '../../packages/core/src/storage/test-path.js';
import { tempDir } from '../helpers.js';

const ACCEPTED: Array<[string, string]> = [
  ['flows/orders.yaml', 'flows/orders.yaml'],
  ['tests/flows/orders.yaml', 'flows/orders.yaml'],
  ['  smoke.yml  ', 'smoke.yml'],
  ['./a/./b.json', 'a/b.json'],
  ['ai/Orders Flow.YAML', 'ai/Orders Flow.YAML'],
  ['ai/x.suite.yaml', 'ai/x.suite.yaml'],
  ['ai/..yaml-name.yaml', 'ai/..yaml-name.yaml'],
];

/** [path, why]: refused on every OS. */
const REFUSED: Array<[string, RegExp]> = [
  ['../outside.yaml', /escapes/],
  ['a/../../x.yaml', /escapes/],
  ['a/../b.yaml', /escapes/],
  ['tests/../x.yaml', /escapes/],
  ['..', /escapes/],
  ['..\\x.yaml', /escapes/],
  ['a\\..\\..\\x.yaml', /escapes/],
  ['a\\b.yaml', /escapes.*use \//],
  ['a/b\\..\\..\\..\\x.yaml', /escapes/],
  ['C:\\Windows\\x.yaml', /escapes.*drive/],
  ['C:/Windows/x.yaml', /escapes.*drive/],
  ['c:x.yaml', /escapes.*drive/],
  ['\\\\server\\share\\x.yaml', /escapes.*absolute/],
  ['//server/share/x.yaml', /escapes.*absolute/],
  ['\\\\?\\C:\\x.yaml', /escapes.*absolute/],
  ['\\x.yaml', /escapes.*absolute/],
  ['/tmp/x.yaml', /escapes.*absolute/],
  ['%2e%2e/x.yaml', /escapes.*percent/],
  ['%2E%2E%2Fx.yaml', /escapes.*percent/],
  ['..%2fx.yaml', /escapes.*percent/],
  ['a%5c..%5cx.yaml', /escapes.*percent/],
  ['a/x.yaml\u0000.txt', /control character/],
  ['a/\nx.yaml', /control character/],
  ['a//x.yaml', /empty folder name/],
  ['a/x.yaml/', /empty folder name/],
  ['a/x.yaml:stream', /Windows does not allow/],
  ['a/x?.yaml', /Windows does not allow/],
  ['a/x<1>.yaml', /Windows does not allow/],
  ['a./x.yaml', /dot or a space/],
  ['a /x.yaml', /dot or a space/],
  ['CON.yaml', /device name/],
  ['a/nul.json', /device name/],
  ['com1/x.yaml', /device name/],
  ['LPT9.yml', /device name/],
  [`${'a'.repeat(101)}.yaml`, /longer than 100/],
  [`${'abcdefghi/'.repeat(25)}x.yaml`, new RegExp(`longer than ${MAX_TEST_PATH}`)],
  ['', /empty/],
  ['   ', /empty/],
  ['tests', /YAML or JSON/],
  ['notes.txt', /YAML or JSON/],
  ['flows/orders.yaml.js', /YAML or JSON/],
  ['.', /no file name/],
];

describe('test file paths from outside: one answer on every OS', () => {
  it.each(ACCEPTED)('accepts %j as %j', (asked, rel) => {
    expect(relativeTestFilePath(asked)).toBe(rel);
  });

  it.each(REFUSED)('refuses %j', (asked, why) => {
    expect(() => relativeTestFilePath(asked)).toThrow(why);
    try {
      relativeTestFilePath(asked);
    } catch (e) {
      expect((e as { kind?: string }).kind).toBe('ValidationError');
    }
  });

  it('refuses what is not text', () => {
    for (const v of [undefined, null, 3, {}, ['a.yaml']]) expect(() => relativeTestFilePath(v)).toThrow(/not text/);
  });

  it('the cases node:path answers differently on Windows and POSIX are refused regardless (what used to pass on Linux and macOS)', () => {
    // node:path on the other OS, explicitly: these are absolute (or leave the folder) on one OS and harmless names on the other
    const differs = REFUSED.map(([p]) => p).filter((p) => {
      const leaves = (path: typeof posix) => path.isAbsolute(p) || path.normalize(p).split(path.sep).includes('..');
      return leaves(posix) !== leaves(win32);
    });
    expect(differs).toEqual(expect.arrayContaining(['C:\\Windows\\x.yaml', 'C:/Windows/x.yaml', '..\\x.yaml', 'a\\..\\..\\x.yaml', '\\\\server\\share\\x.yaml', '\\x.yaml']));
    for (const p of differs) expect(() => relativeTestFilePath(p)).toThrow(/escapes/);
    // every accepted path is a plain relative path inside the folder under both
    for (const [, rel] of ACCEPTED) for (const path of [posix, win32]) expect(path.isAbsolute(rel) || path.normalize(rel).split(/[\\/]/).includes('..')).toBe(false);
  });

  it('a link under tests/ that leads outside is refused before writing (realpath containment)', () => {
    const { dir, cleanup } = tempDir();
    try {
      const tests = join(dir, 'ws', 'tests');
      const outside = join(dir, 'outside');
      mkdirSync(tests, { recursive: true });
      mkdirSync(outside, { recursive: true });
      mkdirSync(join(tests, 'real'));
      writeFileSync(join(tests, 'real', 'a.yaml'), 'x');
      // a junction needs no rights on Windows; a dir link elsewhere
      symlinkSync(outside, join(tests, 'out'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(realTestFilePath(tests, 'real/a.yaml')).toBe(join(tests, 'real', 'a.yaml'));
      expect(checkedTestFilePath(tests, 'tests/new/deep/b.yaml')).toEqual({ rel: 'new/deep/b.yaml', abs: join(tests, 'new', 'deep', 'b.yaml') });
      expect(() => checkedTestFilePath(tests, 'out/x.yaml')).toThrow(/link in tests\/ leads outside/);
      expect(() => checkedTestFilePath(tests, 'out/sub/new.yaml')).toThrow(/link in tests\/ leads outside/);
      // the workspace itself reached through a link is fine: both sides are resolved
      const linkedWs = join(dir, 'ws-link');
      symlinkSync(join(dir, 'ws'), linkedWs, process.platform === 'win32' ? 'junction' : 'dir');
      expect(checkedTestFilePath(join(linkedWs, 'tests'), 'real/a.yaml').rel).toBe('real/a.yaml');
    } finally {
      cleanup();
    }
  });
});
