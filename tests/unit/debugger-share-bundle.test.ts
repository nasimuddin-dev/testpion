import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Redactor, gitStatus, listSharedSessions, openShareBundle, shareSessionBundle, undoJournal, unshareSession } from '../../packages/core/src/index.js';
import { makeRepo } from '../helpers-git';

// FG-24: git share-session --bundle writes the masked session with the enabled rules to debugger/shared/<name>.tpbundle.
describe('share session as a bundle', () => {
  it('writes a masked bundle with the enabled rules, tracked by git, listed, undoable and removable', async () => {
    const r = await makeRepo();
    try {
      const har = {
        log: {
          version: '1.2',
          creator: { name: 'x', version: '1' },
          entries: [
            {
              startedDateTime: '2026-10-28T10:00:00.000Z',
              time: 12,
              request: { method: 'GET', url: 'https://api.test/a', httpVersion: 'HTTP/1.1', headers: [{ name: 'Authorization', value: 'Bearer abcdef0123456789abcdef0123456789' }], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
              response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [], content: { size: 0, mimeType: '' }, redirectURL: '', headersSize: -1, bodySize: 0 },
              cache: {},
              timings: { send: 0, wait: 12, receive: 0 },
            },
          ],
        },
      };
      r.write('debugger/bug.har', JSON.stringify(har));
      r.write('debugger/rules.json', JSON.stringify({ active: 'Default', profiles: { Default: [{ id: 'r1', name: 'on', enabled: true, kind: 'ignore', match: { host: 'ads.test' } }, { id: 'r2', name: 'off', enabled: false, kind: 'ignore', match: { host: 'x.test' } }] } }));
      const redactor = new Redactor();
      const dry = await shareSessionBundle(r.store, 'bug', { redactor, dryRun: true });
      expect(dry).toMatchObject({ applied: false, entries: 1, to: 'debugger/shared/bug.tpbundle' });
      expect(existsSync(join(r.ws, 'debugger', 'shared'))).toBe(false);
      const res = await shareSessionBundle(r.store, 'bug', { redactor, notes: 'Repro: open /a' });
      expect(res.applied).toBe(true);
      const bytes = readFileSync(join(r.ws, 'debugger', 'shared', 'bug.tpbundle'));
      expect(bytes.includes(Buffer.from('abcdef0123456789abcdef0123456789'))).toBe(false);
      const b = openShareBundle(bytes);
      expect(b.exchanges).toHaveLength(1);
      expect(b.rules.map((x) => x.id)).toEqual(['r1']); // only the enabled rule travels
      expect(b.notes).toContain('Repro');
      expect((await gitStatus(r.ws)).files.map((f) => f.path)).toContain('debugger/shared/bug.tpbundle');
      expect(listSharedSessions(r.store)).toMatchObject([{ name: 'bug', kind: 'bundle' }]);
      undoJournal(r.ws, res.undoId);
      expect(existsSync(join(r.ws, 'debugger', 'shared', 'bug.tpbundle'))).toBe(false);
      await shareSessionBundle(r.store, 'bug', { redactor });
      expect(unshareSession(r.store, 'bug').removed).toBe(true);
      expect(unshareSession(r.store, 'bug').removed).toBe(false);
      await expect(shareSessionBundle(r.store, 'nope', { redactor })).rejects.toThrow(/no saved session/);
    } finally {
      r.cleanup();
    }
  });
});
