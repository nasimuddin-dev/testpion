import { PROVIDER_PRESETS } from '@testpion/shared';
import type { LibraryItem, ProviderConfig } from '../model/types.js';
import { EVALUATIONS_LIBRARY, type SavedEvaluation } from '../runner/saved-evaluations.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { shortId } from '../util/ids.js';

/**
 * The sample evaluation (AU-4): ten support messages to sort into cancellation, refill, booking or other, graded by "the
 * reply contains the expected answer", answered by the offline demo model (rules, no key, no network). One call makes the
 * whole thing, so the first result needs no setup: `ai.sample` (the app), `testpion eval sample`, the `eval_sample` tool.
 */
export const SAMPLE_NAME = 'Sample: support intents';
/** The id of the offline demo provider the sample runs on (the same one the "Use the offline demo model" button adds). */
export const OFFLINE_DEMO_ID = 'demo';
/** How the offline demo model answers a customer message of the sample: by the words in it. */
const DEMO_RULES = [
  { match: 'Customer:[^\\n]*\\bcancel', response: '{"intent":"cancellation"}' },
  { match: 'Customer:[^\\n]*\\brefill', response: '{"intent":"refill"}' },
  { match: 'Customer:[^\\n]*\\b(book|schedule)', response: '{"intent":"booking"}' },
  { match: 'Customer:', response: '{"intent":"other"}' },
];

const CASES: Array<[string, string]> = [
  ['Cancel my appointment', 'cancellation'],
  ['I need to cancel my Friday visit', 'cancellation'],
  ['I need a refill', 'refill'],
  ['Can I get a refill of my prescription?', 'refill'],
  ['Can I book for Tuesday?', 'booking'],
  ['I want to schedule a checkup', 'booking'],
  ['Please book me a slot next week', 'booking'],
  ['What are your opening hours?', 'other'],
  ['Where can I park?', 'other'],
  ['Do you accept walk-ins?', 'other'],
];

/** The sample as a saved evaluation (the offline demo model, ten cases, one check). */
export function sampleEvaluation(provider = OFFLINE_DEMO_ID): SavedEvaluation {
  return {
    name: SAMPLE_NAME,
    type: 'llm',
    provider,
    model: 'demo',
    temperature: 0,
    prompt: 'Classify the customer message as cancellation, refill, booking or other. Respond with JSON {"intent": "cancellation" | "refill" | "booking" | "other"}.\n\nCustomer: {{input}}',
    format: 'json',
    datasetFormat: 'jsonl',
    dataset: CASES.map(([input, expected]) => JSON.stringify({ input, expected })).join('\n'),
    expectedField: 'expected',
    evaluators: [{ type: 'contains', expected: '{{expected}}', ignoreCase: true }],
    concurrency: 4,
    retries: 0,
  };
}

export interface SampleResult {
  /** The saved evaluation to run. */
  evaluation: SavedEvaluation & { id: string };
  /** The evaluation was not there before. */
  created: boolean;
  /** The offline demo model was added to the workspace's providers. */
  providerAdded: boolean;
}

/**
 * Make sure the workspace has the offline demo model and the sample evaluation, as written above (a sample that was
 * edited is put back: make your own with Duplicate). Nothing is run here and nothing is sent anywhere.
 */
export function ensureSample(store: WorkspaceStore): SampleResult {
  const preset = PROVIDER_PRESETS.find((p) => p.id === OFFLINE_DEMO_ID && p.kind === 'mock')!;
  const providers = store.getProviders();
  let demo = providers.find((p) => p.id === OFFLINE_DEMO_ID);
  const providerAdded = !demo;
  const config: ProviderConfig = { ...(demo ?? { id: preset.id, name: preset.name, kind: preset.kind, baseUrl: preset.baseUrl, defaultModel: preset.defaultModel }), kind: 'mock', headers: [{ key: 'x-mock-rules', value: JSON.stringify(DEMO_RULES) }] };
  if (!demo || demo.headers?.find((h) => h.key.toLowerCase() === 'x-mock-rules')?.value !== config.headers![0]!.value) {
    store.saveProviders(demo ? providers.map((p) => (p === demo ? config : p)) : [...providers, config]);
    demo = config;
  }
  const lib = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY);
  const data = sampleEvaluation(demo.id);
  const have = lib.items.find((i) => i.name === SAMPLE_NAME);
  const item: LibraryItem<SavedEvaluation> = have ? { ...have, data, updatedAt: new Date().toISOString() } : { id: shortId('ev-'), name: SAMPLE_NAME, data, updatedAt: new Date().toISOString() };
  store.saveLibrary(EVALUATIONS_LIBRARY, { folders: lib.folders, items: have ? lib.items.map((i) => (i === have ? item : i)) : [...lib.items, item] });
  return { evaluation: { ...data, id: item.id }, created: !have, providerAdded };
}
