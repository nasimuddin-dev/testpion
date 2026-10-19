import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { WorkspaceStore, isInside, pathMatcher, plainFileInside, realPathOf, relativeInside, samePath } from '../../packages/core/src/index.js';
import { historyResponse } from '../../packages/core/src/storage/history-compare.js';
import { tempDir } from '../helpers.js';

// The containment check that guards every read and write of a named path: the real paths decide. A workspace reached
// through a link is still itself (what macOS does to every temp folder, so the suite runs through an aliased temp
// folder on every OS); a path that only names the workspace but leads elsewhere through a link INSIDE it (a junction
// under payloads/, a linked spec) is outside, however it is spelled. A junction needs no privilege on Windows; a file
// link does, so that case is skipped where it cannot be made.
const tmp = tempDir('tp-containment-', { alias: true });
const root = join(tmp.dir, 'ws');
const outside = join(tmp.dir, 'outside');
const secret = join(outside, 'secret.txt');
let fileLinks = true;

const dirLink = (target: string, at: string) => symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');

beforeAll(() => {
  WorkspaceStore.create(root, 'Contained').close();
  mkdirSync(join(root, 'payloads'), { recursive: true });
  mkdirSync(join(root, 'specs'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(secret, 'not for export');
  writeFileSync(join(root, 'payloads', 'own.bin'), '{"ok":true}');
  dirLink(outside, join(root, 'payloads', 'link'));
  dirLink(outside, join(root, 'specs', 'elsewhere'));
  try {
    symlinkSync(secret, join(root, 'payloads', 'evil.bin'), 'file');
  } catch {
    fileLinks = false; // Windows without developer mode: a file link needs a privilege
  }
});
afterAll(() => tmp.cleanup());

describe('relativeInside: the real path decides', () => {
  it('a junction inside the workspace that leads outside is outside, however the path is spelled', () => {
    expect(relativeInside(join(root, 'payloads'), join(root, 'payloads', 'link', 'secret.txt'))).toBeUndefined();
    expect(isInside(root, join(root, 'specs', 'elsewhere', 'x.yaml'))).toBe(false);
    // the linked folder itself names a folder elsewhere
    expect(isInside(root, join(root, 'payloads', 'link'))).toBe(false);
    expect(samePath(join(root, 'payloads', 'link'), join(root, 'payloads', 'link'))).toBe(true);
  });

  it('the workspace through its alias and its real folder are one, named as the workspace names them', () => {
    const real = realpathSync(root);
    expect(real).not.toBe(root);
    expect(relativeInside(root, join(real, 'payloads', 'own.bin'))).toBe(join('payloads', 'own.bin'));
    expect(relativeInside(real, join(root, 'payloads', 'own.bin'))).toBe(join('payloads', 'own.bin'));
    expect(relativeInside(root, real, { orSame: true })).toBe('');
    expect(isInside(root, join(outside, 'secret.txt'))).toBe(false);
    expect(isInside(root, join(root, '..', 'outside', 'secret.txt'))).toBe(false);
  });

  it('a file not written yet is where its folder really is; a name under a junction is where the junction leads', () => {
    expect(realPathOf(join(root, 'payloads', 'new.bin'))).toBe(join(realpathSync(root), 'payloads', 'new.bin'));
    expect(realPathOf(join(root, 'payloads', 'link', 'new.txt'))).toBe(join(realpathSync(outside), 'new.txt'));
  });

  it('a file link inside payloads/ is refused for a read of a named file, a plain file is not', () => {
    expect(plainFileInside(join(root, 'payloads'), join(root, 'payloads', 'own.bin'))).toBe(11);
    expect(plainFileInside(join(root, 'payloads'), join(realpathSync(root), 'payloads', 'own.bin'))).toBe(11);
    expect(plainFileInside(join(root, 'payloads'), join(root, 'payloads', 'link', 'secret.txt'))).toBeUndefined();
    expect(plainFileInside(join(root, 'payloads'), join(root, 'payloads', 'missing.bin'))).toBeUndefined();
    if (fileLinks) expect(plainFileInside(join(root, 'payloads'), join(root, 'payloads', 'evil.bin'))).toBeUndefined();
  });

  it('pathMatcher: as written, or really, with the target resolved once', () => {
    const is = pathMatcher(join(root, 'payloads', 'own.bin'));
    expect(is(join(realpathSync(root), 'payloads', 'own.bin'))).toBe(true);
    // as written, case is aside on every system (how recorded result files were always compared)
    expect(is(join(root, 'payloads', 'own.bin').replace(/\\/g, '/').toUpperCase())).toBe(true);
    expect(is(join(root, 'payloads', 'link', 'secret.txt'))).toBe(false);
    expect(is(undefined)).toBe(false);
  });
});

describe('safePath and the readers of named files', () => {
  it('safePath refuses a path through a link inside the workspace and takes the real path of its own files', () => {
    const s = WorkspaceStore.open(root);
    try {
      expect(() => s.safePath('specs/elsewhere/x.yaml')).toThrow(/escapes the workspace/);
      expect(() => s.safePath(join(root, 'payloads', 'link', 'secret.txt'))).toThrow(/escapes the workspace/);
      expect(s.safePath('specs/mine.yaml')).toBe(join(root, 'specs', 'mine.yaml'));
      expect(s.safePath(join(realpathSync(root), 'specs', 'mine.yaml'))).toBe(join(root, 'specs', 'mine.yaml'));
      expect(s.isInside(join(root, 'payloads', 'link', 'secret.txt'), 'payloads')).toBe(false);
      expect(s.isInside(join(root, 'payloads', 'own.bin'), 'payloads')).toBe(true);
    } finally {
      s.close();
    }
  });

  it('a history entry whose payload path leads outside through a link has no body', () => {
    const s = WorkspaceStore.open(root);
    try {
      const entry = (payloadPath: string) => ({ id: 'h', timestamp: '', kind: 'http' as const, name: 'x', payloadPath });
      expect(historyResponse(s, entry(join(root, 'payloads', 'own.bin'))).body).toBe('{"ok":true}');
      expect(historyResponse(s, entry(join(realpathSync(root), 'payloads', 'own.bin'))).body).toBe('{"ok":true}');
      expect(historyResponse(s, entry(join(root, 'payloads', 'link', 'secret.txt'))).bodyMissing).toBe(true);
      expect(historyResponse(s, entry(secret)).bodyMissing).toBe(true);
      if (fileLinks) expect(historyResponse(s, entry(join(root, 'payloads', 'evil.bin'))).bodyMissing).toBe(true);
    } finally {
      s.close();
    }
  });

  it('output.save refuses a response source that leads outside payloads/ through a link', async () => {
    const dest = join(tmp.dir, 'out', 'body.txt');
    mkdirSync(join(tmp.dir, 'out'), { recursive: true });
    const be = new Backend({ appDir: join(tmp.dir, 'app'), emit: () => {}, noMonitors: true, saveDialog: async () => dest });
    be.openStore(root);
    try {
      const save = (payloadPath: string) => be.invoke('output.save', { surface: 'response.body', format: 'raw', suggestedName: 'body.txt', source: { kind: 'response', payloadPath } });
      await expect(save(join(root, 'payloads', 'link', 'secret.txt'))).rejects.toThrow(/no longer on disk/);
      if (fileLinks) await expect(save(join(root, 'payloads', 'evil.bin'))).rejects.toThrow(/no longer on disk/);
      expect(((await save(join(realpathSync(root), 'payloads', 'own.bin'))) as { bytes: number }).bytes).toBe(11);
    } finally {
      await be.dispose();
    }
  });
});
