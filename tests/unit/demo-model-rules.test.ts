import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, ensureDemoModel } from '../../packages/core/src/index.js';

/**
 * The offline demo model's rules are put back by the sample, but the rules a workspace gave it (the Examples workspace's
 * injection refusal, tool call and haiku) and its other headers stay: the sample's rules first, the workspace's after them.
 */
describe('ensureDemoModel keeps the workspace rules of the demo model', () => {
  it('merges the rules, keeps other headers, and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-demo-rules-'));
    try {
      const theirs = [{ match: 'haiku', response: 'Requests fly out fast' }, { match: 'Customer:', response: '{"intent":"other"}' }];
      const store = WorkspaceStore.create(join(dir, 'ws'), 'Demo rules');
      try {
        store.saveProviders([{ id: 'demo', name: 'Offline demo model', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'demo', headers: [{ key: 'x-mock-rules', value: JSON.stringify(theirs) }, { key: 'x-mock-latency-ms', value: '120' }] }]);
        const { provider, added } = ensureDemoModel(store);
        expect(added).toBe(false);
        const rules = JSON.parse(provider.headers!.find((h) => h.key === 'x-mock-rules')!.value) as Array<{ match: string }>;
        // the sample's rules first (they answer the sample's prompts), the workspace's own after them, duplicates by match dropped
        expect(rules[0]!.match).toBe('"existingCount"');
        expect(rules.some((r) => r.match === 'haiku')).toBe(true);
        expect(rules.filter((r) => r.match === 'Customer:')).toHaveLength(1);
        expect(rules.findIndex((r) => r.match === 'haiku')).toBeGreaterThan(rules.findIndex((r) => r.match.startsWith('Evaluation task')));
        expect(provider.headers!.find((h) => h.key === 'x-mock-latency-ms')?.value).toBe('120');
        const again = ensureDemoModel(store).provider;
        expect(again.headers).toEqual(provider.headers);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
