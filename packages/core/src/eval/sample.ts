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
/** What the offline demo model writes when it is asked for test cases (AU-13): six new support messages, so the generator works with no key. */
const DEMO_CASES = {
  summary: 'Six new support messages: a cancellation, a refill, a booking and three that need none of them.',
  cases: [
    { inputs: { input: 'Please cancel my visit for tomorrow morning' }, expected: 'cancellation', tags: ['cancel'], why: 'A cancellation worded differently from the examples' },
    { inputs: { input: 'My prescription runs out Friday, can you refill it?' }, expected: 'refill', tags: ['refill'], why: 'A refill with a deadline' },
    { inputs: { input: 'I would like to book a dental cleaning' }, expected: 'booking', tags: ['book'], why: 'A booking for a service' },
    { inputs: { input: 'Do you have a phone number for after hours?' }, expected: 'other', tags: ['other'], why: 'A question that is none of the three' },
    { inputs: { input: 'ok' }, expected: 'other', tags: ['edge'], why: 'A very short message with no request' },
    { inputs: { input: 'Cancel it. Actually, can I book the Thursday slot instead?' }, expected: 'cancellation', tags: ['edge'], why: 'Two requests in one message: the first one wins' },
  ],
};
/** How the offline demo model answers a customer message of the sample: by the words in it. */
const DEMO_RULES = [
  { match: '"existingCount"', response: JSON.stringify(DEMO_CASES) },
  { match: 'Customer:[^\\n]*\\bcancel', response: '{"intent":"cancellation"}' },
  { match: 'Customer:[^\\n]*\\brefill', response: '{"intent":"refill"}' },
  { match: 'Customer:[^\\n]*\\b(book|schedule)', response: '{"intent":"booking"}' },
  { match: 'Customer:', response: '{"intent":"other"}' },
];

/** A judge verdict as the offline demo model writes it: one item per claim, `verdict` true when the claim holds. */
const verdict = (items: Array<[text: string, verdict: boolean, reason?: string]>) =>
  JSON.stringify({ reasoning: 'decided by rule (offline demo)', items: items.map(([text, v, reason]) => ({ text, verdict: v, reason: reason ?? '', rating: 1 })) });
const PARKING = 'Parking is free for patients';
const EMERGENCY = 'Emergency care is available around the clock at the main clinic';
/**
 * How the offline demo model answers as the AI reviewer of the bot sample (eval/rag/sample.ts): the claims of each answer, whether
 * the retrieved documents back them, and whether they address the question. The parking answer is the seeded defect: its first
 * claim is backed by no document. Any other reviewer prompt gets a passing verdict, so every judged metric runs offline.
 */
const DEMO_JUDGE_RULES = [
  { match: 'Evaluation task: CLAIMS[\\s\\S]*free for patients', response: verdict([[PARKING, true], [EMERGENCY, true]]) },
  { match: 'Evaluation task: CLAIMS[\\s\\S]*could not find', response: verdict([]) },
  { match: 'Evaluation task: CLAIMS', response: verdict([['The answer states what the retrieved document says', true]]) },
  { match: 'Evaluation task: FAITHFULNESS[\\s\\S]*Parking is free', response: verdict([[PARKING, false, 'no retrieved document mentions parking'], [EMERGENCY, true, '[doc-4] "around the clock"']]) },
  { match: 'Evaluation task: FAITHFULNESS', response: verdict([['The answer states what the retrieved document says', true, 'stated by the retrieved document']]) },
  { match: 'Evaluation task: ANSWER RELEVANCE[\\s\\S]*Parking is free', response: verdict([[PARKING, true, 'answers the question'], [EMERGENCY, false, 'the question did not ask about emergency care']]) },
  { match: 'Evaluation task', response: verdict([['The answer addresses the question', true, 'decided by rule']]) },
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
 * The offline demo model of the workspace (id `demo`): added when it is not there, and its rules put back as written (the
 * sample's answers and the test cases it writes). No key, no network. `ai.demoModel`, the sample and the case generator use it.
 */
export function ensureDemoModel(store: WorkspaceStore): { provider: ProviderConfig; added: boolean } {
  const preset = PROVIDER_PRESETS.find((p) => p.id === OFFLINE_DEMO_ID && p.kind === 'mock')!;
  const providers = store.getProviders();
  let demo = providers.find((p) => p.id === OFFLINE_DEMO_ID);
  const added = !demo;
  const config: ProviderConfig = { ...(demo ?? { id: preset.id, name: preset.name, kind: preset.kind, baseUrl: preset.baseUrl, defaultModel: preset.defaultModel }), kind: 'mock', headers: [{ key: 'x-mock-rules', value: JSON.stringify([...DEMO_RULES, ...DEMO_JUDGE_RULES]) }] };
  if (!demo || demo.headers?.find((h) => h.key.toLowerCase() === 'x-mock-rules')?.value !== config.headers![0]!.value) {
    store.saveProviders(demo ? providers.map((p) => (p === demo ? config : p)) : [...providers, config]);
    demo = config;
  }
  return { provider: demo, added };
}

/**
 * Make sure the workspace has the offline demo model and the sample evaluation, as written above (a sample that was
 * edited is put back: make your own with Duplicate). Nothing is run here and nothing is sent anywhere.
 */
export function ensureSample(store: WorkspaceStore): SampleResult {
  const { provider: demo, added: providerAdded } = ensureDemoModel(store);
  const lib = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY);
  const data = sampleEvaluation(demo.id);
  const have = lib.items.find((i) => i.name === SAMPLE_NAME);
  const item: LibraryItem<SavedEvaluation> = have ? { ...have, data, updatedAt: new Date().toISOString() } : { id: shortId('ev-'), name: SAMPLE_NAME, data, updatedAt: new Date().toISOString() };
  store.saveLibrary(EVALUATIONS_LIBRARY, { folders: lib.folders, items: have ? lib.items.map((i) => (i === have ? item : i)) : [...lib.items, item] });
  return { evaluation: { ...data, id: item.id }, created: !have, providerAdded };
}
