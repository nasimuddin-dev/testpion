import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, attentionKey, listSnoozes, snoozeAttention, splitSnoozed, unsnoozeAttention, type AttentionItem } from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'tp-snooze-'));
const store = WorkspaceStore.create(join(dir, 'ws'), 'Snooze');
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const monitor = (message: string): AttentionItem => ({ kind: 'monitor', severity: 'high', group: 'Monitors', type: 'failure', message, ref: { kind: 'monitor', monitorId: 'm1' } });
const cert: AttentionItem = { kind: 'certificate', severity: 'medium', group: 'Certificates', type: 'warning', message: 'The certificate of api.example.com expires in 9 days', ref: { kind: 'certificate', host: 'api.example.com' } };

describe('snoozed problems', () => {
  it('a snooze for a while hides the problem until the time; the key names the item, not its words', () => {
    const now = Date.parse('2026-11-01T10:00:00Z');
    const failing = monitor('Monitor "Health" is failing: 2 of 4 requests failed');
    expect(attentionKey(failing)).toBe('monitor|monitor|m1|');
    const s = snoozeAttention(store, failing, { minutes: 60 }, now);
    expect(s.until).toBe('2026-11-01T11:00:00.000Z');
    const during = splitSnoozed(store, [failing, cert], now + 30 * 60_000);
    expect(during.shown.map((i) => i.key)).toEqual(['certificate|certificate|api.example.com']);
    expect(during.snoozed.map((i) => [i.key, i.snoozed.until])).toEqual([['monitor|monitor|m1|', '2026-11-01T11:00:00.000Z']]);
    const after = splitSnoozed(store, [failing, cert], now + 61 * 60_000);
    expect(after.shown).toHaveLength(2);
    expect(after.snoozed).toEqual([]);
    expect(listSnoozes(store)).toEqual({});
  });

  it('a snooze until it changes ends when the words change; Bring it back ends it at once; the file is this computer’s (.local)', () => {
    const now = Date.parse('2026-11-01T10:00:00Z');
    const failing = monitor('Monitor "Health" is failing: 2 of 4 requests failed');
    snoozeAttention(store, failing, {}, now);
    expect(existsSync(store.path('.local', 'attention-snooze.json'))).toBe(true);
    expect(splitSnoozed(store, [failing], now + 10 * 86_400_000).shown).toEqual([]);
    const worse = monitor('Monitor "Health" is failing: 4 of 4 requests failed');
    expect(splitSnoozed(store, [worse], now).shown.map((i) => i.message)).toEqual([worse.message]);
    expect(listSnoozes(store)).toEqual({});
    snoozeAttention(store, failing, {}, now);
    expect(unsnoozeAttention(store, attentionKey(failing))).toBe(true);
    expect(unsnoozeAttention(store, attentionKey(failing))).toBe(false);
    expect(() => snoozeAttention(store, failing, { minutes: 0 }, now)).toThrow(/1 minute to 30 days/);
  });
});
