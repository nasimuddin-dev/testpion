import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, expandImportFiles, planImport, importDocument } from '../../packages/core/src/index.js';
import { handOff, peekParsed, takeParsed } from '../../packages/core/src/import/parsed.js';

// I-3: a document that was already parsed (or assembled as an object) is not written out and parsed again by the importer.
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const postman = (n: number) =>
  JSON.stringify({
    info: { name: 'Big', _postman_id: 'big', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: Array.from({ length: n }, (_, i) => ({ name: `Request ${i}`, request: { method: 'GET', url: { raw: `{{baseUrl}}/r${i}` } } })),
  });

/** How many times JSON.parse read a text of at least `min` characters while `fn` ran. */
function bigParses<T>(min: number, fn: () => T): { calls: number; value: T } {
  const real = JSON.parse;
  let calls = 0;
  const spy = vi.spyOn(JSON, 'parse').mockImplementation(((text: string, reviver?: never) => {
    if (typeof text === 'string' && text.length >= min) calls++;
    return real(text, reviver);
  }) as typeof JSON.parse);
  try {
    const value = fn();
    return { calls, value };
  } finally {
    spy.mockRestore();
  }
}

describe('the hand-off of a parsed document', () => {
  it('is taken once, then the text is parsed as usual', () => {
    const text = handOff('{"a":1}', { a: 1 });
    expect(peekParsed(text)).toEqual({ a: 1 });
    expect(takeParsed(text)).toEqual({ a: 1 });
    expect(peekParsed(text)).toBeUndefined();
    expect(takeParsed(text)).toEqual({ a: 1 }); // parsed from the text this time
  });

  it('a Postman file is parsed once by the format check and the importer together', () => {
    const text = postman(3000);
    const { calls } = bigParses(50_000, () => importDocument(text));
    expect(calls).toBe(1);
    // and the preview of a workspace import
    const dir = mkdtempSync(join(tmpdir(), 'tp-handoff-'));
    dirs.push(dir);
    const store = WorkspaceStore.create(join(dir, 'ws'), 'W');
    const { calls: previewCalls, value } = bigParses(50_000, () => planImport(store, text));
    expect(value.collections[0]!.requests).toBe(3000);
    expect(previewCalls).toBeLessThanOrEqual(1);
    store.close();
  });

  it('a picked Postman v3 folder is not written out as one text and parsed again', () => {
    const files = Array.from({ length: 400 }, (_, i) => ({
      path: `Big/Folder/request-${i}.request.yaml`,
      data: `$kind: http-request\nname: Request ${i}\nmethod: GET\nurl: '{{baseUrl}}/r${i}'\n${'# padding\n'.repeat(40)}`,
    }));
    files.push({ path: 'Big/.resources/definition.yaml', data: '$kind: collection\nname: Big\n' });
    const { inputs } = expandImportFiles(files as never, { folderName: 'Big' });
    expect(inputs.length).toBe(1);
    const { calls, value } = bigParses(50_000, () => importDocument(inputs[0]!.text));
    expect(inputs[0]!.text.length).toBeGreaterThan(50_000);
    expect(calls).toBe(0);
    expect(value.document.collections[0]!.items.length).toBeGreaterThan(0);
  });

  it('a v1 file is converted without being written out and read again', () => {
    const v1 = JSON.stringify({
      id: 'c1',
      name: 'Old',
      order: ['r1'],
      requests: [{ id: 'r1', name: 'One', method: 'GET', url: 'https://x.test/a', headers: '', data: [], dataMode: 'params' }],
    });
    const doc = importDocument(v1).document;
    expect(doc.format).toBe('postman-v1');
    expect(doc.collections[0]!.items.length).toBe(1);
    expect(doc.bytes).toBe(Buffer.byteLength(v1));
  });
});
