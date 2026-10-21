import { describe, expect, it } from 'vitest';
import { decodeBase64 } from '../../packages/core/src/index.js';
import { MAX_SESSIONS, rememberSession, sessionCount } from '../../apps/desktop/backend/handlers/import.js';

// Limits on what an import holds in memory: previews kept for the import that follows (count and age), and base64
// uploads refused by their length before anything is decoded.
describe('import previews kept in memory', () => {
  const session = (at: number) => ({ inputs: [], skipped: [], at });

  it('are bounded in count: the oldest goes when a new one needs the room', () => {
    const t = Date.now();
    for (let i = 0; i < MAX_SESSIONS * 3; i++) rememberSession(`imps-${i}`, session(t + i), t + i);
    expect(sessionCount()).toBe(MAX_SESSIONS);
  });

  it('are bounded in age: an expired one is dropped when the next is kept', () => {
    const t = Date.now() + 10_000_000;
    rememberSession('imps-old', session(t), t);
    const later = t + 31 * 60_000;
    rememberSession('imps-new', session(later), later);
    // the old ones expired (30 minutes), the new one is kept
    expect(sessionCount()).toBe(1);
  });
});

describe('base64 uploads', () => {
  it('are refused by length before they are decoded, and decode when they fit', () => {
    // 4 million characters would decode to 3 MB: over a 1 MB limit it is refused on the length alone
    expect(() => decodeBase64('A'.repeat(4 * 1024 * 1024), 1024 * 1024, 'big.zip')).toThrow(/big\.zip is larger than 1 MB/);
    expect(decodeBase64(Buffer.from('hello').toString('base64'), 1024).toString()).toBe('hello');
  });
});
