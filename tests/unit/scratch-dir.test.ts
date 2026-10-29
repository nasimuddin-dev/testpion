import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeScratchDir } from '../../packages/core/src/storage/fsutil.js';

describe('removeScratchDir', () => {
  it('removes a folder with files in it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-scratch-'));
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    writeFileSync(join(dir, 'a', 'b', 'f.txt'), 'x');
    removeScratchDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('never throws: a folder that is already gone, or cannot be removed, is not an error', () => {
    expect(() => removeScratchDir(join(tmpdir(), 'tp-scratch-never-existed'))).not.toThrow();
    // a path with a NUL byte makes the call itself fail; a finished run must not
    expect(() => removeScratchDir('bad\0path')).not.toThrow();
  });
});
