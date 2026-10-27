import { afterAll, describe, expect, it } from 'vitest';
import { decodeBase64 } from '../../packages/core/src/index.js';
import { ImportPreviews, MAX_PREVIEWS } from '../../apps/desktop/backend/import-previews.js';
import { MAX_SESSIONS, previewsOf, rememberSession, sessionCount } from '../../apps/desktop/backend/handlers/import.js';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { tempDir } from '../helpers.js';

// Limits on what an import holds in memory: previews kept for the import that follows (count and age), and base64
// uploads refused by their length before anything is decoded.
describe('import previews kept in memory', () => {
  const tmp = tempDir('tp-imp-lim-');
  const be = new Backend({ appDir: tmp.dir, emit: () => {}, noMonitors: true });
  const other = new Backend({ appDir: tmp.dir + '-2', emit: () => {}, noMonitors: true });
  afterAll(async () => {
    await be.dispose();
    await other.dispose();
    tmp.cleanup();
  });
  const session = (at: number, text = '') => ({ inputs: text ? [{ name: 'x', text, source: 'x', fileCount: 1 }] : [], skipped: [], at });

  it('are bounded in count: the oldest goes when a new one needs the room', () => {
    const t = Date.now();
    for (let i = 0; i < MAX_SESSIONS * 3; i++) rememberSession(be, `imps-${i}`, session(t + i), t + i);
    expect(sessionCount(be)).toBe(MAX_SESSIONS);
    expect(MAX_SESSIONS).toBe(MAX_PREVIEWS);
  });

  it('are bounded in age: an expired one is dropped when the next is kept', () => {
    const t = Date.now() + 10_000_000;
    rememberSession(be, 'imps-old', session(t), t);
    const later = t + 31 * 60_000;
    rememberSession(be, 'imps-new', session(later), later);
    // the old ones expired (30 minutes), the new one is kept
    expect(sessionCount(be)).toBe(1);
  });

  it('are bounded in bytes by the host: the oldest goes when the text held together passes the budget', () => {
    const p = new ImportPreviews(100);
    p.remember('a', session(1, 'x'.repeat(60)), 1);
    p.remember('b', session(2, 'y'.repeat(60)), 2);
    expect(p.get('a')).toBeUndefined();
    expect(p.get('b')).toBeDefined();
    expect(p.bytes).toBe(60);
    // one bigger than the whole budget is still kept (the import that follows needs it), alone
    p.remember('c', session(3, 'z'.repeat(500)), 3);
    expect(p.size).toBe(1);
    p.clear();
  });

  it('belong to their session: another user previews neither share the room nor are pushed out', () => {
    const t = Date.now();
    rememberSession(other, 'imps-theirs', session(t), t);
    for (let i = 0; i < MAX_SESSIONS * 2; i++) rememberSession(be, `imps-mine-${i}`, session(t + i), t + i);
    expect(previewsOf(other).get('imps-theirs')).toBeDefined();
    expect(previewsOf(be).get('imps-theirs')).toBeUndefined();
    expect(sessionCount(other)).toBe(1);
  });
});

describe('base64 uploads', () => {
  it('are refused by length before they are decoded, and decode when they fit', () => {
    // 4 million characters would decode to 3 MB: over a 1 MB limit it is refused on the length alone
    expect(() => decodeBase64('A'.repeat(4 * 1024 * 1024), 1024 * 1024, 'big.zip')).toThrow(/big\.zip is larger than 1 MB/);
    expect(decodeBase64(Buffer.from('hello').toString('base64'), 1024).toString()).toBe('hello');
  });
});
