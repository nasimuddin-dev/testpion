import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { adoptSaved, changedFields, clearDrafts, discardDraft, dirtyCollectionIds, editDraft, markSaved, resolveConflict, useCollectionDrafts } from '../../apps/desktop/src/lib/collection-draft';
import type { Collection } from '../../apps/desktop/src/types';

// The 2026-10-22 user-friendliness review: guards for what it fixed (one section per finding).
const SRC = join(__dirname, '../../apps/desktop/src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));
const rel = (f: string) => f.slice(SRC.length + 1).replace(/\\/g, '/');

const col = (over: Partial<Collection> = {}): Collection => ({ schemaVersion: '1.0', id: 'c1', name: 'API', version: 1, variables: [], items: [], updatedAt: '', ...over }) as Collection;
const entry = () => useCollectionDrafts.getState().entries.c1;

describe('collection settings drafts survive refreshes (P0)', () => {
  it('keeps unsaved fields when a newer saved version arrives, takes the other fields from it', () => {
    clearDrafts();
    adoptSaved(col());
    editDraft({ ...entry().draft, variables: [{ key: 'a', value: '1', enabled: true }] } as Collection);
    expect(changedFields(entry().base, entry().draft)).toEqual(['variables']);
    // a request saved in a REST tab: new version, new items, a new description
    adoptSaved(col({ version: 2, items: [{ kind: 'http', id: 'r', name: 'R', request: { method: 'GET', url: '/' } }] as never, description: 'new docs' }));
    expect(entry().draft.variables).toHaveLength(1);
    expect(entry().draft.version).toBe(2);
    expect(entry().draft.items).toHaveLength(1);
    expect(entry().draft.description).toBe('new docs');
    expect(entry().conflict).toEqual([]);
    expect(dirtyCollectionIds(useCollectionDrafts.getState().entries)).toEqual(['c1']);
  });

  it('an untouched draft follows the saved collection; saving clears the dirty mark', () => {
    clearDrafts();
    adoptSaved(col());
    adoptSaved(col({ version: 2, name: 'Renamed' }));
    expect(entry().draft.name).toBe('Renamed');
    editDraft({ ...entry().draft, testScript: 'x' });
    markSaved(entry().draft);
    expect(dirtyCollectionIds(useCollectionDrafts.getState().entries)).toEqual([]);
  });

  it('a field both sides changed is a conflict the user settles', () => {
    clearDrafts();
    adoptSaved(col({ preRequestScript: 'a' }));
    editDraft({ ...entry().draft, preRequestScript: 'mine' });
    adoptSaved(col({ version: 2, preRequestScript: 'theirs' }));
    expect(entry().conflict).toEqual(['preRequestScript']);
    expect(entry().draft.preRequestScript).toBe('mine');
    resolveConflict('c1', 'theirs');
    expect(entry().draft.preRequestScript).toBe('theirs');
    expect(entry().conflict).toEqual([]);
  });

  it('discard returns to the saved collection', () => {
    clearDrafts();
    adoptSaved(col());
    editDraft({ ...entry().draft, description: 'x' });
    discardDraft('c1');
    expect(changedFields(entry().base, entry().draft)).toEqual([]);
  });

  it('every view that edits a draft with setDraft( registers a leave guard (or saves as you type)', () => {
    // document-tab views: the draft lives in a tab that is marked dirty, kept across views and asked about on close
    const NO_GUARD_NEEDED = new Set(['views/EnvironmentsView.tsx', 'views/McpView.tsx']);
    const offenders = files(SRC)
      .filter((f) => /views\/[A-Za-z]+View\.tsx$/.test(f.replace(/\\/g, '/')))
      .filter((f) => /\bsetDraft\(/.test(readFileSync(f, 'utf8')) && !/useLeaveGuard\(/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .filter((f) => !NO_GUARD_NEEDED.has(f));
    expect(offenders).toEqual([]);
  });
});

describe('errors say what to do (P1)', () => {
  it('a refused connection and a missing file are said in words; the code moves to details', async () => {
    const { normalizeError } = await import('../../packages/core/src/errors');
    const refused = normalizeError(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 3000 }) }));
    expect(refused.message).toBe('Nothing is listening at 127.0.0.1:3000');
    expect(refused.message).not.toMatch(/E[A-Z]{4,}/);
    expect(refused.details).toMatchObject({ code: 'ECONNREFUSED' });
    expect(refused.suggestions[0]).toMatch(/Start the server/);
    const bare = normalizeError({ code: 'ECONNREFUSED', message: 'fetch failed' });
    expect(bare.message).not.toMatch(/E[A-Z]{4,}/);
    const missing = normalizeError(Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\data\\rows.csv'"), { code: 'ENOENT' }));
    expect(missing.message).toBe('"C:\\data\\rows.csv" was not found');
    expect(missing.message).not.toMatch(/ENOENT/);
    expect(normalizeError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.nope.test' }).message).toBe('The host name "api.nope.test" could not be found');
  });

  it('a failure toast shows why and the first thing to try (errorNextStep)', async () => {
    const { ApsError } = await import('../../packages/core/src/errors');
    const { errorNextStep } = await import('../../apps/desktop/src/lib/error-text');
    const e = new ApsError('NetworkError', 'Could not reach api.test').toJSON();
    const next = errorNextStep(e);
    expect(next).toContain(e.suggestions[0]!);
    expect(errorNextStep({ message: 'x', why: 'An unexpected error occurred while executing the operation.', suggestions: [] })).toBeUndefined();
  });

  it('no handler builds an error toast from the engine message by hand: toastError adds why and the next step', () => {
    const offenders: string[] = [];
    // updates.ts writes its own second sentence for the update check
    const ALLOWED = new Set(['updates.ts']);
    for (const f of files(SRC)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/toast\(\s*`[^`]*\$\{[^}]*(?:\.message|String\(e)[^}]*\}[^`]*`\s*,\s*'error'/g)) if (!ALLOWED.has(rel(f))) offenders.push(`${rel(f)}: ${m[0].slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });
});
