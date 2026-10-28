import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// The script worker pool starts worker_threads from files: in the packaged app they must be on disk (asarUnpack), or the pool cannot
// start (security review 2026-10-27, scalability stage 1 gap). electron-builder.yml is parsed, not grepped.
const builder = parse(readFileSync(join(process.cwd(), 'apps/desktop/electron-builder.yml'), 'utf8')) as { asar?: boolean; asarUnpack?: string[]; files?: string[] };
const build = readFileSync(join(process.cwd(), 'apps/desktop/scripts/build-main.mjs'), 'utf8');

describe('electron-builder asarUnpack', () => {
  it('the script worker and the lazy bundles are unpacked from app.asar', () => {
    expect(builder.asar).toBe(true);
    expect(builder.asarUnpack).toEqual(expect.arrayContaining(['dist-electron/script-worker.cjs', 'dist-electron/lazy/**']));
  });

  it('they are files the build really makes under dist-electron, and are shipped (files: dist-electron/**)', () => {
    expect(build).toContain("'script-worker.cjs'");
    expect(build).toMatch(/lazy/);
    expect(builder.files).toContain('dist-electron/**');
    expect(builder.files).not.toContain('!dist-electron/script-worker.cjs');
  });
});
