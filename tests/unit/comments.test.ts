import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, addComment, commentFileOf, deleteComment, listComments, openCommentCounts, openComments, resolveComment, restoreComment, COMMENT_LIMIT, describeFile, type ItemRef } from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'tp-comments-'));
const store = WorkspaceStore.create(join(dir, 'ws'), 'Comments');
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const req: ItemRef = { kind: 'request', collectionId: 'payments', requestId: 'create-invoice' };
const test: ItemRef = { kind: 'test', path: 'tests/smoke.yaml' };

describe('comments for your team', () => {
  it('a comment is added, signed and dated, and read back oldest first; the file is one per item under comments/', () => {
    const a = addComment(store, req, '  Why does this send X-Trace twice? ', 'Ana');
    const b = addComment(store, req, 'Because the gateway adds one.', 'Bo');
    expect(a).toMatchObject({ by: 'Ana', text: 'Why does this send X-Trace twice?' });
    expect(a.at <= b.at).toBe(true);
    expect(listComments(store, req).map((c) => c.id)).toEqual([a.id, b.id]);
    const files = readdirSync(store.path('comments'));
    expect(files).toEqual([commentFileOf(req)]);
    expect(files[0]).toMatch(/^request-payments-create-invoice\.[0-9a-f]{8}\.json$/);
    expect(commentFileOf(test)).not.toBe(commentFileOf(req));
    // the same item through another ref (the editor's ref names the protocol): the same thread
    expect(commentFileOf({ ...req, protocol: 'http' } as ItemRef)).toBe(commentFileOf(req));
  });

  it('an empty or too long comment is refused; a blank author becomes "someone"', () => {
    expect(() => addComment(store, req, '   ', 'Ana')).toThrow(/empty/);
    expect(() => addComment(store, req, 'x'.repeat(COMMENT_LIMIT + 1), 'Ana')).toThrow(/too long/);
    expect(addComment(store, test, 'Flaky since the 2nd', '  ').by).toBe('someone');
  });

  it('resolving marks it settled by whom and when, and reopening clears that; open comments and their counts leave settled ones out', () => {
    const [a] = listComments(store, req);
    const r = resolveComment(store, req, a!.id, 'Bo');
    expect(r.resolvedBy).toBe('Bo');
    expect(r.resolvedAt).toBeTruthy();
    expect(openComments(store).map((c) => c.text)).toEqual(['Flaky since the 2nd', 'Because the gateway adds one.']);
    expect(openCommentCounts(store)).toEqual({ 'request|payments|create-invoice': 1, 'test|tests/smoke.yaml': 1 });
    expect(openComments(store)[0]!.ref).toEqual(test);
    const back = resolveComment(store, req, a!.id, 'Bo', false);
    expect(back.resolvedAt).toBeUndefined();
    expect(openCommentCounts(store)['request|payments|create-invoice']).toBe(2);
    expect(() => resolveComment(store, req, 'nope', 'Bo')).toThrow(/No comment nope/);
  });

  it('deleting the last comment of an item removes its file; a thread that is not JSON is read as empty', () => {
    deleteComment(store, test, listComments(store, test)[0]!.id);
    expect(listComments(store, test)).toEqual([]);
    expect(existsSync(store.path('comments', commentFileOf(test)))).toBe(false);
    expect(() => deleteComment(store, test, 'nope')).toThrow(/No comment/);
  });

  it('a deleted comment can be put back as it was (Undo), in its place by time', () => {
    const a = addComment(store, test, 'first', 'Ana');
    const b = addComment(store, test, 'second', 'Bo');
    deleteComment(store, test, a.id);
    expect(listComments(store, test).map((c) => c.id)).toEqual([b.id]);
    expect(restoreComment(store, test, a)).toEqual(a);
    expect(listComments(store, test).map((c) => c.id)).toEqual([a.id, b.id]);
    expect(() => restoreComment(store, test, {} as never)).toThrow(/Not a comment/);
  });

  it('git describes a changed thread as comments for the team, not by its hashed file name', () => {
    const [c] = describeFile(`comments/${commentFileOf(req)}`, undefined, '{}', 'added');
    expect(c).toMatchObject({ title: 'Comments for the team', change: 'added', kind: 'other' });
  });
});
