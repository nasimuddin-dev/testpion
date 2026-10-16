import { describe, expect, it } from 'vitest';
import { jsonPaths, suggestJsonPaths } from '../../apps/desktop/src/lib/json-paths';
import { forgetResponses, keptRequests, previousResponse, rememberResponse, responseId } from '../../apps/desktop/src/lib/response-memory';
import { diffResponses } from '@testpion/shared';

const body = {
  items: [
    { id: 1, name: 'a', tags: ['x'] },
    { id: 2, name: 'b', owner: { 'first-name': 'c' } },
  ],
  total: 2,
  'next-page': null,
  empty: [],
};

describe('JSONPath suggestions', () => {
  it('lists every path once, arrays as [*] with their elements merged', () => {
    const p = jsonPaths(body);
    expect(p).toEqual([
      '$.items',
      '$.items[*]',
      '$.items[*].id',
      '$.items[*].name',
      '$.items[*].tags',
      '$.items[*].tags[*]',
      '$.items[*].owner',
      '$.items[*].owner["first-name"]',
      '$.total',
      '$["next-page"]',
      '$.empty',
    ]);
  });

  it('stays bounded on big bodies', () => {
    const big = { rows: Array.from({ length: 100_000 }, (_, i) => ({ [`k${i}`]: i })) };
    const p = jsonPaths(big, { max: 500 });
    expect(p.length).toBeLessThanOrEqual(500);
    // only the first elements are read (50 by default): 1 + [*] + 50 keys
    expect(jsonPaths(big).length).toBe(52);
  });

  it('completes a path, the next level first', () => {
    const p = jsonPaths(body);
    expect(suggestJsonPaths(p, '')).toEqual(['$.items', '$.total', '$["next-page"]', '$.empty']);
    expect(suggestJsonPaths(p, '$.ite').slice(0, 2)).toEqual(['$.items', '$.items[*]']);
    expect(suggestJsonPaths(p, '$.items[*].')[0]).toBe('$.items[*].id');
    expect(suggestJsonPaths(p, '$.ITEMS[*].na')).toEqual(['$.items[*].name']);
    expect(suggestJsonPaths(p, '$.items[*].name')).toEqual([]); // complete: nothing more to add
  });

  it('a plain word finds keys anywhere, the ones that start with it first', () => {
    const p = jsonPaths(body);
    expect(suggestJsonPaths(p, 'name')).toEqual(['$.items[*].name', '$.items[*].owner["first-name"]']);
    expect(suggestJsonPaths(p, 'zzz')).toEqual([]);
  });
});

describe('Diff vs previous: the responses kept per request', () => {
  const res = (body: string, status = 200) => ({
    status,
    statusText: '',
    headers: [['content-type', 'application/json']] as Array<[string, string]>,
    cookies: [],
    bodyPreview: body,
    truncated: false,
    size: body.length,
    contentType: 'application/json',
    durationMs: 10,
    timeline: [],
    url: 'http://x',
    redirected: false,
  });

  it('keeps the previous response of each request, not the same send twice', () => {
    forgetResponses();
    rememberResponse('req-1', 't1', res('{"a":1}'));
    expect(previousResponse('req-1', 't1')).toBeUndefined();
    rememberResponse('req-1', 't1', res('{"a":1}')); // shown again (a tab switch): nothing changes
    rememberResponse('req-1', 't2', res('{"a":2,"b":true}', 201));
    const prev = previousResponse('req-1', 't2')!;
    expect(prev.id).toBe('t1');
    const d = diffResponses(prev.response, { status: 201, body: '{"a":2,"b":true}', headers: [['content-type', 'application/json']] });
    expect(d.body.changes.map((c) => `${c.kind} ${c.path}`)).toEqual(['changed $.a', 'added $.b']);
    expect(d.status.changed).toBe(true);
    // an older send shown again has nothing before it here
    expect(previousResponse('req-1', 't1')).toBeUndefined();
  });

  it('keeps 20 requests at most and cuts long bodies', () => {
    forgetResponses();
    for (let i = 0; i < 50; i++) rememberResponse(`req-${i}`, 'a', res('{}'));
    expect(keptRequests()).toBe(20);
    rememberResponse('long', 'a', res('x'.repeat(600 * 1024)));
    rememberResponse('long', 'b', res('y'));
    const prev = previousResponse('long', 'b')!;
    expect(prev.cut).toBe(true);
    expect(prev.response.body!.length).toBe(512 * 1024);
    forgetResponses();
  });

  it('a response without an id gets one per object', () => {
    const a = {};
    expect(responseId(a)).toBe(responseId(a));
    expect(responseId({})).not.toBe(responseId(a));
  });
});

import { jsonPathProblem, rootedJsonPath } from '../../apps/desktop/src/lib/json-paths';
describe('JSONPath shape check', () => {
  it('accepts real paths, says what is wrong with the others', () => {
    for (const ok of ['$', '$.items[*].name', '$..id', '$["next-page"]', '$.items[?(@.id > 1)]', '$.a[0,1]', "$['a]b']"]) expect(jsonPathProblem(ok), ok).toBeUndefined();
    // without the $ a path is read from the root, as the engine's checks read it (items[0].id is $.items[0].id)
    for (const ok of ['items', 'errors[0].message', '[0]', ' data.id ']) expect(jsonPathProblem(ok), ok).toBeUndefined();
    expect(jsonPathProblem('items[')).toMatch(/missing/);
    expect(jsonPathProblem('$.a[')).toMatch(/missing/);
    expect(jsonPathProblem('$.a]')).toMatch(/closes nothing/);
    expect(jsonPathProblem('$.a[]')).toMatch(/empty \[\]/);
    expect(jsonPathProblem('$.a.')).toMatch(/ends with a dot/);
    expect(jsonPathProblem('$["a]')).toMatch(/quote/);
  });
  it('reads a path without the $ from the root', () => {
    expect(rootedJsonPath('errors')).toBe('$.errors');
    expect(rootedJsonPath('errors[0].message')).toBe('$.errors[0].message');
    expect(rootedJsonPath('[0].id')).toBe('$[0].id');
    expect(rootedJsonPath('$..id')).toBe('$..id');
    expect(rootedJsonPath('  ')).toBe('$');
  });
});
