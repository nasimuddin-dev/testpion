import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readZip as readImportZip, writeZip } from '../../packages/core/src/index.js';

// B-41: one zip parser. The import reads archives with a policy over the hardened reader of transfer/zip.ts.

const SRC = join(__dirname, '..', '..', 'packages', 'core', 'src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith('.ts') ? [join(dir, n)] : []));

describe('one zip reader', () => {
  it('only transfer/zip.ts finds the directory and inflates entries; the import reader is a policy over it', () => {
    const parsers = files(SRC).filter((f) => /inflateRawSync|findEndOfDirectory|readRecord\(/.test(readFileSync(f, 'utf8')));
    expect(parsers.map((f) => relative(SRC, f).split('\\').join('/'))).toEqual(['transfer/zip.ts']);
    expect(readFileSync(join(SRC, 'import', 'zip.ts'), 'utf8')).toMatch(/from '\.\.\/transfer\/zip\.js'/);
  });

  it('the import policy: junk files left out, a backslash is a separator, ./ is dropped, the names stay inside the archive', () => {
    const zip = writeZip([
      { name: '__MACOSX/._a.json', data: Buffer.from('x') },
      { name: 'Thumbs.db', data: Buffer.from('x') },
      { name: 'sub/.DS_Store', data: Buffer.from('x') },
      { name: 'dir\\a.json', data: Buffer.from('{}') },
      { name: './b.json', data: Buffer.from('{}') },
      { name: 'c.json', data: Buffer.from('{}') },
    ]);
    expect(readImportZip(zip).map((e) => e.path)).toEqual(['dir/a.json', 'b.json', 'c.json']);
    // a backslash that climbs out is still refused, in the import's own words
    expect(() => readImportZip(writeZip([{ name: 'a\\..\\..\\evil.json', data: Buffer.from('x') }]))).toThrow(/This archive cannot be imported: .*leaves the archive/);
    // a case-only repeat is refused by the one reader (it would collide on Windows and macOS)
    expect(() => readImportZip(writeZip([{ name: 'A.json', data: Buffer.from('1') }, { name: 'a.json', data: Buffer.from('2') }]))).toThrow(/appears twice/);
  });

  it('the import keeps its own limits (20,000 entries, 200 MB in all, 50 MB for one, a ratio of 200)', () => {
    expect(() => readImportZip(writeZip([{ name: 'a', data: Buffer.from('1') }, { name: 'b', data: Buffer.from('2') }]), { maxEntries: 1 })).toThrow(/at most 1/);
    expect(() => readImportZip(writeZip([{ name: 'big.json', data: Buffer.alloc(2_000_000, 0x20) }]), { maxEntryBytes: 1_000_000 })).toThrow(/at most 1000000/);
    expect(() => readImportZip(writeZip([{ name: 'big.json', data: Buffer.alloc(5_000_000, 0x20) }]))).toThrow(/zip bomb/);
    expect(readImportZip(writeZip([{ name: 'ok.json', data: Buffer.alloc(100_000, 0x20) }]), { maxRatio: 1000 })).toHaveLength(1);
  });
});
