import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COLLECTION_CALL_LIBRARIES, collectionCallKind, isCollectionCallLibrary, liveKinds, kindOfLibrary } from '@testpion/shared';

describe('saved calls and connections of a collection (B-40c)', () => {
  it('the helpers agree with the item-kind registry: the library kinds that have a collection as parent', () => {
    const fromRegistry = liveKinds()
      .filter((k) => k.storage.layout === 'library' && k.parent === 'collection')
      .map((k) => k.library)
      .sort();
    expect([...COLLECTION_CALL_LIBRARIES].sort()).toEqual(fromRegistry);
    for (const lib of COLLECTION_CALL_LIBRARIES) {
      expect(isCollectionCallLibrary(lib)).toBe(true);
      expect(kindOfLibrary(lib)?.id, lib).toBe(collectionCallKind(lib));
    }
    expect(isCollectionCallLibrary('ai-prompts')).toBe(false);
    expect(isCollectionCallLibrary(undefined)).toBe(false);
  });

  it('the window does not choose between the two kinds with a literal pair', () => {
    const root = resolve(__dirname, '..', '..', 'apps/desktop/src');
    const found: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && readFileSync(p, 'utf8').match(/['"]grpc-call['"]\s*:\s*['"]ws-connection['"]|['"]ws-connection['"]\s*:\s*['"]grpc-call['"]|=== 'grpc' \|\| [\w.]+ === 'websocket'/)) found.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    expect(found, 'use collectionCallKind(library) / isCollectionCallLibrary(x) from @testpion/shared').toEqual([]);
  });
});
