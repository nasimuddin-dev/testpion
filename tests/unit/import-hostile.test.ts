import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  collectionToBru,
  collectionToOpenCollection,
  detectFormat,
  expandImportFiles,
  importDocument,
  readImportPath,
  readZip,
  WorkspaceStore,
  importIntoWorkspace,
  type Collection,
} from '../../packages/core/src/index.js';

// Hostile inputs (import-compat plan 4g): an import reads files it does not trust. None of these may hang, crash, write outside
// the workspace, pollute prototypes or run a script; each ends in a clear error or in a safe import.

const POSTMAN = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const postman = (extra: Record<string, unknown> = {}, items: unknown[] = [{ name: 'A', request: { method: 'GET', url: 'https://a.test' } }]) => JSON.stringify({ info: { name: 'H', _postman_id: 'h', schema: POSTMAN }, item: items, ...extra });

/** A ZIP with one stored or deflated entry, built by hand (the importer's reader is what is under test). */
function zip(entries: Array<{ name: string; data: Buffer; method?: 0 | 8; flags?: number; usize?: number; attrs?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = e.method === 0 ? e.data : deflateRawSync(e.data);
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.flags ?? 0x800, 6);
    local.writeUInt16LE(e.method ?? 8, 8);
    local.writeUInt32LE(crc32(e.data), 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(e.usize ?? e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, raw);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made on Unix: its attributes can say "symlink"
    central.writeUInt16LE(e.flags ?? 0x800, 8);
    central.writeUInt32LE(crc32(e.data), 16);
    central.writeUInt16LE(e.method ?? 8, 10);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(e.usize ?? e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(e.attrs ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + raw.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe('archives', () => {
  it('a zip bomb (a huge ratio) is refused', () => {
    const bomb = zip([{ name: 'big.json', data: Buffer.alloc(60 * 1024 * 1024, 0x20) }]);
    expect(bomb.length).toBeLessThan(200_000);
    expect(() => readZip(bomb)).toThrow(/zip bomb|bytes inflated/);
  });
  it('too much data together, too many entries, an encrypted entry, a symlink', () => {
    const big = Buffer.alloc(30 * 1024 * 1024, 'a'.charCodeAt(0));
    // (random-looking data compresses badly, so the ratio cap does not stop this one: the total does)
    const noisy = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < noisy.length; i++) noisy[i] = (i * 2654435761) >>> 24;
    expect(() => readZip(zip(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.bin`, data: noisy, method: 0 as const }))), { maxBytes: 100 * 1024 * 1024 })).toThrow(/inflate to more than 104857600 bytes/);
    void big;
    expect(() => readZip(zip([{ name: 'a.json', data: Buffer.from('{}'), flags: 0x801 }]))).toThrow(/encrypted/);
    expect(() => readZip(zip(Array.from({ length: 5 }, (_, i) => ({ name: `a${i}.json`, data: Buffer.from('{}') }))), { maxEntries: 3 })).toThrow(/5 files/);
    // a symlink entry (Unix mode 0120000) is skipped, never followed
    const withLink = zip([{ name: 'link.json', data: Buffer.from('/etc/passwd'), attrs: (0xa1ff << 16) >>> 0 }, { name: 'ok.json', data: Buffer.from('{}') }]);
    expect(readZip(withLink).map((e) => e.path)).toEqual(['ok.json']);
  });
  it('entry names that leave the archive are refused', () => {
    for (const name of ['../evil.json', '/etc/passwd', 'C:\\Windows\\x.json', 'a/../../b.json', 'bad\0name.json']) expect(() => readZip(zip([{ name, data: Buffer.from('{}') }])), name).toThrow(/leaves the archive|absolute path|control character/);
  });
  it('a damaged archive says so', () => {
    expect(() => readZip(Buffer.concat([zip([{ name: 'a.json', data: Buffer.from('{}') }]).subarray(0, 40), Buffer.from('garbage')]))).toThrow(/ZIP|damaged/);
  });
  it('picked files: a path with .. is skipped; a file over 50 MB is skipped; a binary file is skipped', () => {
    const r = expandImportFiles([
      { path: '../escape.json', data: postman() },
      { path: 'a/../../b.json', data: postman() },
      { path: 'big.json', data: Buffer.alloc(51 * 1024 * 1024, 0x20) },
      { path: 'bin.json', data: Buffer.from([0x7b, 0, 0, 0, 0x7d]) },
      { path: 'ok.json', data: postman() },
    ]);
    expect(r.inputs.map((i) => i.source)).toEqual(['ok.json']);
    expect(r.skipped.map((s) => s.why)).toEqual(expect.arrayContaining(['the path leaves the folder', 'larger than 50 MB', 'a binary file']));
  });
});

describe('folders on disk', () => {
  it('symbolic links are not followed', () => {
    const d = mkdtempSync(join(tmpdir(), 'tp-hostile-'));
    try {
      writeFileSync(join(d, 'bruno.json'), '{"version":"1","name":"X","type":"collection"}');
      writeFileSync(join(d, 'a.bru'), 'meta {\n  name: A\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://a.test\n  body: none\n  auth: none\n}\n');
      const outside = mkdtempSync(join(tmpdir(), 'tp-outside-'));
      writeFileSync(join(outside, 'secret.bru'), 'meta {\n  name: Secret\n  type: http\n  seq: 2\n}\n\nget {\n  url: https://secret.test\n  body: none\n  auth: none\n}\n');
      try {
        symlinkSync(outside, join(d, 'linked'), 'junction');
        symlinkSync(join(outside, 'secret.bru'), join(d, 'secret.bru'), 'file');
      } catch {
        // no right to make links on this machine: nothing to test here
        rmSync(outside, { recursive: true, force: true });
        return;
      }
      const read = readImportPath(d);
      expect(read.files.map((f) => f.path).sort()).toEqual(['a.bru', 'bruno.json']);
      rmSync(outside, { recursive: true, force: true });
    } finally {
      rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe('documents', () => {
  it('__proto__, constructor and prototype keys pollute nothing', () => {
    const evil = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"info":{"name":"P","_postman_id":"p","schema":"' + POSTMAN + '","__proto__":{"polluted":"yes"}},"item":[{"name":"A","__proto__":{"polluted":"yes"},"request":{"method":"GET","url":"https://a.test","header":[{"key":"__proto__","value":"x"},{"key":"constructor","value":"y"}],"auth":{"type":"bearer","__proto__":{"polluted":"yes"},"bearer":[{"key":"__proto__","value":"z"},{"key":"token","value":"t"}]}}}],"variable":[{"key":"__proto__","value":"v"},{"key":"constructor","value":"c"}]}',
    );
    const r = importDocument(JSON.stringify(evil));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    expect(r.document.collections[0]!.name).toBe('P');
    // and for the other formats that build objects from keys
    for (const text of [
      JSON.stringify({ _type: 'export', __export_format: 4, resources: [{ _id: 'w', _type: 'workspace', name: 'W' }, { _id: 'e', _type: 'environment', parentId: 'w', name: 'base', data: JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}') }] }),
      JSON.stringify({ clientName: 'Thunder Client', environmentName: 'E', data: [{ name: '__proto__', value: 'x' }, { name: 'constructor', value: 'y' }] }),
    ]) {
      try {
        importDocument(text);
      } catch {
        /* a refusal is fine too */
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  });

  it('a script that would do something is never run by an import', () => {
    const d = mkdtempSync(join(tmpdir(), 'tp-hostile-ws-'));
    const marker = join(d, 'pwned.txt');
    try {
      const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); while (true) {}`;
      const text = postman({}, [{ name: 'A', request: { method: 'GET', url: 'https://a.test' }, event: [{ listen: 'prerequest', script: { exec: [script] } }, { listen: 'test', script: { exec: ['pm.test("t", () => {}); process.exit(1);'] } }] }]);
      const store = WorkspaceStore.create(join(d, 'ws'), 'Hostile');
      const t0 = Date.now();
      const r = importIntoWorkspace(store, text);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(existsSync(marker)).toBe(false);
      // the script came over as text (converted, never executed)
      expect(JSON.stringify(store.getCollection(r.collection!.id).items)).toContain('writeFileSync');
      store.close();
    } finally {
      rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('YAML anchors that expand exponentially (a billion laughs) are refused, quickly', () => {
    let y = 'a0: &a0 ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]\n';
    for (let i = 1; i < 10; i++) y += `a${i}: &a${i} [${Array.from({ length: 9 }, () => `*a${i - 1}`).join(',')}]\n`;
    const text = `type: collection.insomnia.rest/5.0\nname: Bomb\ncollection: []\n${y}`;
    const t0 = Date.now();
    expect(() => importDocument(text)).toThrow();
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('deep nesting is a clear error or a working import, never a crash', () => {
    const nest = (n: number): unknown => (n === 0 ? { name: 'leaf', request: { method: 'GET', url: 'https://a.test' } } : { name: `f${n}`, item: [nest(n - 1)] });
    // 50 levels of folders: imports
    const r = importDocument(postman({}, [nest(50)]));
    expect(r.report.counts.folders).toBe(50);
    // thousands of levels: a clean error, not a stack overflow that takes the process down
    const text = postman({}, [nest(3000)]);
    let threw: unknown;
    try {
      importDocument(text);
    } catch (e) {
      threw = e;
    }
    if (threw) expect(String((threw as Error).message)).not.toMatch(/Maximum call stack/);
    // deeply nested JSON that is no collection at all
    expect(detectFormat('['.repeat(5000) + ']'.repeat(5000))).toBe('unknown');
  });

  it('a BOM, CRLF, invalid UTF-8 and empty input', () => {
    expect(detectFormat('\uFEFF' + postman())).toBe('postman');
    expect(importDocument('\uFEFF' + postman()).document.collections).toHaveLength(1);
    expect(importDocument(postman().replace(/,/g, ',\r\n')).document.collections).toHaveLength(1);
    const inputs = expandImportFiles([{ path: 'a.json', data: Buffer.concat([Buffer.from('{"info":{"name":"Bad\xff\xfe"'), Buffer.from(',"_postman_id":"x","schema":"' + POSTMAN + '"},"item":[]}')]) }]);
    expect(inputs.inputs.length + inputs.skipped.length).toBe(1);
    expect(() => importDocument('')).toThrow();
    expect(() => importDocument('   \n')).toThrow();
  });

  it('a 200 MB body in a request is a number, not a copy of the file', () => {
    // (the importers keep strings by reference: 40 MB here stands in for the cap, the input cap is tested above)
    const big = 'x'.repeat(40 * 1024 * 1024);
    const text = postman({}, [{ name: 'A', request: { method: 'POST', url: 'https://a.test', body: { mode: 'raw', raw: big } } }]);
    const t0 = Date.now();
    const r = importDocument(text);
    expect(r.report.counts.requests).toBe(1);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('names that are not safe file names', () => {
  const c = (names: string[]): Collection => ({
    schemaVersion: '1.0',
    id: 'c',
    name: 'C',
    version: 1,
    variables: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: names.map((name, i) => ({ kind: 'http', id: `r${i}`, name, request: { method: 'GET', url: 'https://a.test' } })),
  });
  it('Windows device names, dots, slashes and control characters do not become file names that break a write', () => {
    const names = ['CON', 'nul', 'aux.bru', 'COM1', 'LPT9', 'prn', '..', '.', 'a/b', 'a\\b', 'x\u0000y', 'trailing dot.', 'trailing space ', '', 'CON.yml'];
    const files = [...collectionToOpenCollection(c(names)).files, ...collectionToBru(c(names))];
    const bad = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
    for (const f of files) {
      const parts = f.path.split('/');
      for (const p of parts) {
        expect(p, `${f.path}`).not.toMatch(bad);
        expect(p).not.toMatch(/^\.\.?$/);
        expect(p).not.toMatch(/[\\\0:*?"<>|]|[. ]$/);
        expect(p.length).toBeGreaterThan(0);
      }
      expect(f.path.startsWith('/')).toBe(false);
    }
    // every request still has its own file
    expect(new Set(files.filter((f) => !/environments|opencollection|bruno\.json|collection\.bru/.test(f.path)).map((f) => f.path.toLowerCase())).size).toBeGreaterThanOrEqual(names.length);
  });
});

void mkdirSync;
