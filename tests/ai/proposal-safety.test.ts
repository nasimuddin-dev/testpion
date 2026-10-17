/**
 * Proposals and AI settings against bad input (mock provider only: nothing here needs a model). A proposal id or a
 * target path that leaves the workspace is refused before anything is read, sent or written; a hand-edited proposal
 * cannot write outside tests/; settings.json with AI settings of the wrong shape falls back to the defaults.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyProposal,
  checkAiCaps,
  discardProposal,
  draftFlowProposal,
  getProposal,
  listProposals,
  normalizeAiSettings,
  runAiTask,
  undoProposal,
  WorkspaceManager,
} from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';
import { harness } from './harness.js';
import { SHOP } from './fixtures.js';

const FLOW = 'name: F\ntests:\n  - id: a\n    type: http\n    method: GET\n    url: "{{baseUrl}}/x"\n';
const ANSWER = `\`\`\`yaml\n${FLOW}\`\`\``;

describe('proposal ids and target paths', () => {
  it('refuses a proposal id with path traversal in every operation', () => {
    const h = harness();
    try {
      for (const id of ['../../settings', 'ai-../../x', '..\\..\\secrets', 'ai-ok/../../x', 'C:\\Windows\\x', '/etc/passwd', 'ai-'])
        for (const op of [getProposal, applyProposal, discardProposal, undoProposal] as Array<(s: typeof h.store, id: string) => unknown>)
          expect(() => op(h.store, id)).toThrow(/is not a proposal id/);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a target path outside tests/ (or not a test file) before anything is sent', async () => {
    const h = harness({ rules: [{ match: '.', response: ANSWER }] });
    try {
      // the same answer on every OS: C:\… and ..\… are plain file names to node:path on Linux and macOS, refused all the same
      for (const path of [
        '../outside.yaml',
        '../../.local/x.yaml',
        'a/../../../x.yaml',
        'C:\\Windows\\x.yaml',
        'C:/Windows/x.yaml',
        'C:x.yaml',
        '..\\..\\x.yaml',
        'a\\..\\..\\x.yaml',
        '\\\\server\\share\\x.yaml',
        '//server/share/x.yaml',
        '/tmp/x.yaml',
        '%2e%2e/x.yaml',
        'tests/../../x.yaml',
        'notes.txt',
      ])
        await expect(runAiTask(h.deps, { task: 'design-flow', question: 'a flow', path })).rejects.toThrow(/escapes the workspace|YAML or JSON/);
      expect(h.rec.requests).toHaveLength(0);
      // tests/ in front is accepted (and dropped)
      const r = await runAiTask(h.deps, { task: 'design-flow', question: 'a flow', path: 'tests/ai/ok.yaml' });
      expect(r.proposal!.items[0]!.path).toBe('ai/ok.yaml');
    } finally {
      h.cleanup();
    }
  });

  it('a flow from a collection refuses a path outside tests/ before the draft is built', async () => {
    const h = harness();
    try {
      h.store.saveCollection(structuredClone(SHOP));
      await expect(draftFlowProposal(h.store, { kind: 'collection', collectionId: 'shop' }, { path: '../../evil.yaml', surface: 'cli' })).rejects.toThrow(/escapes the workspace/);
      await expect(runAiTask(h.deps, { task: 'flow-from-collection', item: { kind: 'collection', collectionId: 'shop' }, path: '../evil.yaml' })).rejects.toThrow(/escapes the workspace/);
      expect(h.rec.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it('a hand-edited proposal cannot write (or undo) outside tests/', async () => {
    const h = harness({ rules: [{ match: '.', response: ANSWER }] });
    try {
      const r = await runAiTask(h.deps, { task: 'design-flow', question: 'a flow', path: 'ai/f.yaml' });
      const id = r.proposal!.id;
      const file = join(h.store.root, '.local', 'ai', 'proposals', `${id}.json`);
      const p = getProposal(h.store, id);
      for (const path of ['../../escaped.yaml', 'C:\\escaped.yaml', '..\\..\\escaped.yaml', '/escaped.yaml']) {
        writeFileSync(file, JSON.stringify({ ...p, items: p.items.map((i) => ({ ...i, path })) }));
        expect(() => applyProposal(h.store, id)).toThrow(/Nothing of .* could be applied: .*escapes the workspace/);
      }
      expect(readdirSync(h.store.path('tests'), { recursive: true }).filter((f) => String(f).includes('escaped'))).toEqual([]);
      expect(existsSync(join(h.store.root, '..', 'escaped.yaml'))).toBe(false);
      expect(existsSync(join(h.store.root, 'escaped.yaml'))).toBe(false);
      // an undo record pointing outside tests/ is refused too
      writeFileSync(file, JSON.stringify({ ...p, status: 'applied', applied: { at: p.createdAt, items: ['i1'], undo: [{ item: 'i1', file: { path: '../../escaped.yaml', before: 'x' } }] } }));
      expect(() => undoProposal(h.store, id)).toThrow(/escapes the workspace/);
      expect(existsSync(join(h.store.root, '..', 'escaped.yaml'))).toBe(false);
      // a damaged file says so, not an internal error
      writeFileSync(file, '{ not json');
      expect(() => getProposal(h.store, id)).toThrow(/cannot be read/);
    } finally {
      h.cleanup();
    }
  });

  it('an unknown status is an error, not an empty list', () => {
    const h = harness();
    try {
      expect(listProposals(h.store, { status: 'open' })).toEqual([]);
      expect(() => listProposals(h.store, { status: 'opne' as 'open' })).toThrow(/not a proposal status/);
    } finally {
      h.cleanup();
    }
  });
});

describe('AI settings of the wrong shape', () => {
  it('fall back to the defaults, field by field', () => {
    for (const bad of [null, 'x', 42, [], { small: 'claude', large: { provider: 5 } }, { localOnly: 'yes', privacy: 'all', maskPersonalData: 0 }]) expect(normalizeAiSettings(bad)).toBeUndefined();
    expect(normalizeAiSettings({ maxTokensPerCall: -5, dailyTokens: 'abc', dailyBudgetUsd: 0, small: { provider: 'ollama', model: 7 }, privacy: 'names', localOnly: true })).toEqual({
      small: { provider: 'ollama' },
      privacy: 'names',
      localOnly: true,
    });
    expect(normalizeAiSettings({ maxTokensPerCall: 1000, dailyTokens: 5000, dailyBudgetUsd: 0.5, large: { provider: 'claude-app', model: 'opus' }, maskPersonalData: false })).toEqual({
      maxTokensPerCall: 1000,
      dailyTokens: 5000,
      dailyBudgetUsd: 0.5,
      large: { provider: 'claude-app', model: 'opus' },
      maskPersonalData: false,
    });
  });

  it('settings.json with broken AI settings loads (no cap refuses every call) and keeps the rest', () => {
    const t = tempDir('tp-ai-settings-');
    try {
      mkdirSync(t.dir, { recursive: true });
      writeFileSync(
        join(t.dir, 'settings.json'),
        JSON.stringify({ assistantProvider: 'mock-ai', density: 'compact', ai: { models: 'x', small: ['ollama'], maxTokensPerCall: -1, dailyTokens: -10, dailyBudgetUsd: 'lots', localOnly: 'true' } }),
      );
      const s = new WorkspaceManager(t.dir).loadSettings();
      expect(s.ai).toBeUndefined();
      expect(s.assistantProvider).toBe('mock-ai');
      expect(s.density).toBe('compact');
      expect(() => checkAiCaps(undefined, s.ai, { tokens: 100 })).not.toThrow();
      expect(readdirSync(t.dir)).toContain('settings.json');
    } finally {
      t.cleanup();
    }
  });

  it('the cap refusal names the setting to change', () => {
    try {
      checkAiCaps(undefined, { maxTokensPerCall: 50 }, { tokens: 100 });
      expect.unreachable();
    } catch (e) {
      const err = e as { message: string; suggestions?: string[] };
      expect(err.message).toMatch(/over the cap of 50 per call/);
      expect(err.suggestions!.join(' ')).toMatch(/Settings ▸ AI assistant ▸ Limits.*"maxTokensPerCall"/);
    }
  });
});
