/**
 * The eval harness of TestPion's own AI tasks (AIB-9): a workspace, a provider and the runner wired as every host
 * wires them. With the mock provider (default) answers are scripted per test; with AI_EVAL_LIVE=1 the cases run
 * against the configured model (TESTPION_AI_PROVIDER / TESTPION_AI_MODEL, keys from the environment) and a scorecard
 * is printed.
 */
import { join } from 'node:path';
import {
  MemorySecretStore,
  ProviderRegistry,
  Redactor,
  VariableScope,
  WorkspaceStore,
  type AiRunDeps,
  type ChatRequest,
  type ChatResponse,
  type LlmProvider,
  type MockRule,
  type ProviderConfig,
} from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

export const LIVE = process.env.AI_EVAL_LIVE === '1';

/** A mock provider config answering with `rules` (scripted `responses` answer in turn). */
export function mockProvider(rules: MockRule[], id = 'mock-ai'): ProviderConfig {
  return { id, name: 'Mock AI', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(rules) }] };
}

/** Records every request a provider gets (what would leave the computer). */
export class Recorder {
  requests: ChatRequest[] = [];
  /** Everything sent, as one text: assert no secret is in it. */
  sent(): string {
    return this.requests.map((r) => r.messages.map((m) => m.content).join('\n')).join('\n---\n');
  }
}

/** A registry whose providers record what they are sent. */
export function recordingRegistry(configs: ProviderConfig[], vars: VariableScope, redactor: Redactor, rec: Recorder): ProviderRegistry {
  const reg = new ProviderRegistry(configs, vars, redactor);
  const get = reg.get.bind(reg);
  reg.get = (ref: string): LlmProvider => {
    const p = get(ref);
    return {
      config: p.config,
      chat: (req: ChatRequest): Promise<ChatResponse> => {
        rec.requests.push(req);
        return p.chat(req);
      },
    };
  };
  return reg;
}

export interface Harness {
  store: WorkspaceStore;
  deps: AiRunDeps;
  rec: Recorder;
  redactor: Redactor;
  vars: VariableScope;
  cleanup(): void;
}

/**
 * A fresh workspace and runner deps. `rules` script the mock; live runs use the environment's model instead.
 * `secrets` are registered as secret variables (their values must never be sent).
 */
export function harness(o: { rules?: MockRule[]; secrets?: Record<string, string>; settings?: AiRunDeps['settings']; surface?: AiRunDeps['surface'] } = {}): Harness {
  const t = tempDir('tp-ai-');
  const store = WorkspaceStore.create(join(t.dir, 'ws'), 'AI eval');
  const redactor = new Redactor();
  const vars = new VariableScope(new MemorySecretStore(), redactor);
  vars.setScope(
    'environment',
    Object.entries(o.secrets ?? {}).map(([key, value]) => ({ key, value, secret: true })),
  );
  const rec = new Recorder();
  const live = LIVE && process.env.TESTPION_AI_PROVIDER;
  const providers = recordingRegistry(live ? [] : [mockProvider(o.rules ?? [])], vars, redactor, rec);
  const deps: AiRunDeps = {
    store,
    providers,
    redactor,
    settings:
      o.settings ??
      (live
        ? { pricing: [] }
        : { assistantProvider: 'mock-ai', assistantModel: 'mock-model', pricing: [{ provider: '*', model: 'mock-model', inputPerMillion: 1, outputPerMillion: 2, version: 'test' }] }),
    surface: o.surface ?? 'cli',
    env: live ? process.env : {},
    variableNames: () => vars.names(),
  };
  return {
    store,
    deps,
    rec,
    redactor,
    vars,
    cleanup: () => {
      store.close();
      t.cleanup();
    },
  };
}

/** What each golden case scored, per test file (printed as the scorecard in live runs). */
const scorecard: Array<{ task: string; case: string; ok: boolean; note?: string }> = [];

/** Record a golden case's outcome (`ok`: what a live model must achieve, not the scripted mock's exact answer). */
export function score(task: string, name: string, r: { calls: number; repairs: number; usage: { totalTokens: number } }, ok: boolean): boolean {
  scorecard.push({ task, case: name, ok, note: `${r.calls} call(s), ${r.repairs} repair(s), ${r.usage.totalTokens} tokens` });
  return ok;
}

/** Print the scorecard of a live run (call it from afterAll). */
export function printScorecard(): void {
  if (!LIVE || !scorecard.length) return;
  const passed = scorecard.filter((s) => s.ok).length;
  console.log(`\nAI eval scorecard (${process.env.TESTPION_AI_PROVIDER}/${process.env.TESTPION_AI_MODEL ?? 'default'}): ${passed}/${scorecard.length}`);
  for (const s of scorecard) console.log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${s.task.padEnd(24)} ${s.case.padEnd(40)} ${s.note ?? ''}`);
}

/** The model runs on this computer (the mock, or a local server named by TESTPION_AI_PROVIDER). */
export const LOCAL_MODEL = !LIVE || /ollama|lm-?studio|local|mock/i.test(process.env.TESTPION_AI_PROVIDER ?? '');
