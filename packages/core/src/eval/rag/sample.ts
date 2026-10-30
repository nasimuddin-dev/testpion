import type { LibraryItem } from '../../model/types.js';
import { EVALUATIONS_LIBRARY, type SavedEvaluation } from '../../runner/saved-evaluations.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { writeOwned } from '../../storage/fsutil.js';
import { shortId } from '../../util/ids.js';
import { ensureDemoModel } from '../sample.js';
import { findRagTarget, saveRagTarget } from './targets.js';
import type { RagTarget } from '@testpion/shared';

/**
 * The bot sample (R-2): a bot with sources that works offline, six questions, and the offline demo model as the AI reviewer,
 * so the first result of Bots with sources needs no key, no network and no server. One call makes the whole thing:
 * `rag.trySample` (the app; `rag.sample` is one sample of a run), `testpion rag sample`, the `eval_sample { kind: "bot" }` tool.
 *
 * The bot is an MCP mock (`mocks/clinic-bot.mcp-mock.yaml`, served in-process) with four clinic documents: it answers each of
 * the six questions with the documents it "retrieved". Two answers are wrong on purpose, each in a different way, so the
 * report has something to show: the parking answer states something no document says (not backed by the sources), and the
 * rabies question retrieves the wrong document (the right document is not found).
 */
export const BOT_SAMPLE_NAME = 'Sample: clinic bot';
export const BOT_SAMPLE_TARGET = 'Clinic bot (offline)';
const SERVER_ID = 'clinic-bot';
const MOCK_FILE = 'mocks/clinic-bot.mcp-mock.yaml';

const DOCS: Record<string, string> = {
  'doc-1': 'The clinic opens at 8am on weekdays and 9am on Saturdays.',
  'doc-2': 'Vaccinations for dogs include rabies and distemper; a booster is due every year.',
  'doc-3': 'Appointments can be cancelled up to 24 hours before without a fee.',
  'doc-4': 'Emergency care is available around the clock at the main clinic.',
};
const NOT_FOUND = 'I could not find that in the clinic documents.';

/** The six questions: what the bot answers and retrieves, and what the right answer and the right documents are. */
const QA: Array<{ id: string; question: string; answer: string; sources: string[]; reference: string; referenceIds: string[] }> = [
  { id: 'hours', question: 'What time does the clinic open?', answer: 'The clinic opens at 8am on weekdays and 9am on Saturdays.', sources: ['doc-1', 'doc-4'], reference: 'The clinic opens at 8am on weekdays and 9am on Saturdays.', referenceIds: ['doc-1'] },
  { id: 'cancel', question: 'Can appointments be cancelled?', answer: 'Appointments can be cancelled up to 24 hours before without a fee.', sources: ['doc-3'], reference: 'Appointments can be cancelled up to 24 hours before without a fee.', referenceIds: ['doc-3'] },
  { id: 'vaccines', question: 'Which vaccinations does a dog need?', answer: 'Vaccinations for dogs include rabies and distemper; a booster is due every year.', sources: ['doc-2'], reference: 'Vaccinations for dogs include rabies and distemper; a booster is due every year.', referenceIds: ['doc-2'] },
  { id: 'emergency', question: 'Is there emergency care at night?', answer: 'Emergency care is available around the clock at the main clinic.', sources: ['doc-4'], reference: 'Emergency care is available around the clock at the main clinic.', referenceIds: ['doc-4'] },
  // the seeded defect: a claim no document backs
  { id: 'parking', question: 'Is parking free?', answer: 'Parking is free for patients. Emergency care is available around the clock at the main clinic.', sources: ['doc-4'], reference: 'The documents do not say whether parking is free.', referenceIds: [] },
  // the seeded retrieval miss: the wrong document is found, so the bot cannot answer
  { id: 'booster', question: 'When is the rabies booster due?', answer: NOT_FOUND, sources: ['doc-1'], reference: 'A rabies booster is due every year.', referenceIds: ['doc-2'] },
];

const SCORES = [0.91, 0.62];
const yamlStr = (s: string) => JSON.stringify(s);

/** The mock definition as YAML (a JSON scalar is a YAML scalar, so every text is quoted with JSON.stringify). */
export function botSampleMockYaml(): string {
  const lines = [
    `name: ${SERVER_ID}`,
    `instructions: ${yamlStr('An offline bot with sources for the TestPion sample: four clinic documents, one answer per question. Nothing leaves the computer.')}`,
    'tools:',
    '  - name: ask',
    `    description: ${yamlStr('Answer a question from the clinic documents, with the documents it was answered from.')}`,
    '    inputSchema:',
    '      type: object',
    '      properties:',
    `        question: { type: string, description: ${yamlStr('The question')} }`,
    '      required: [question]',
    '    annotations: { readOnlyHint: true }',
    '    responses:',
  ];
  for (const q of QA) {
    lines.push(`      - when: { question: ${yamlStr(q.question)} }`);
    lines.push('        json:');
    lines.push(`          answer: ${yamlStr(q.answer)}`);
    lines.push('          sources:');
    q.sources.forEach((id, i) => lines.push(`            - { id: ${yamlStr(id)}, text: ${yamlStr(DOCS[id]!)}, score: ${SCORES[i] ?? 0.5} }`));
  }
  lines.push('      - json:', `          answer: ${yamlStr(NOT_FOUND)}`, '          sources: []', '');
  return lines.join('\n');
}

/** The six questions as the dataset of the evaluation (one JSON record per line: question, reference answer, right documents). */
export function botSampleDataset(): string {
  return QA.map((q) => JSON.stringify({ id: q.id, question: q.question, reference: q.reference, reference_ids: q.referenceIds })).join('\n');
}

/** The bot as a saved target: an MCP tool of the mock server, its answer and sources mapped. */
export function botSampleTarget(): RagTarget {
  return {
    protocol: 'mcp',
    step: { type: 'mcp', server: SERVER_ID, tool: 'ask', arguments: { question: '{{question}}' } },
    mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' } },
    description: 'The sample bot: an offline MCP mock with four clinic documents (mocks/clinic-bot.mcp-mock.yaml).',
    readOnly: true,
  };
}

/** The sample as a saved evaluation: the two goals' measures plus the free ones, the offline demo model as the reviewer. */
export function botSampleEvaluation(target: string, judge = 'demo'): SavedEvaluation {
  return {
    name: BOT_SAMPLE_NAME,
    type: 'rag',
    provider: judge,
    model: 'demo',
    prompt: '',
    format: 'text',
    datasetFormat: 'jsonl',
    dataset: botSampleDataset(),
    expectedField: 'reference',
    evaluators: [
      { type: 'token-f1', threshold: 0.5 },
      { type: 'context-recall-ids', threshold: 0.8 },
      { type: 'faithfulness', threshold: 0.8 },
      { type: 'answer-relevance', threshold: 0.7 },
      { type: 'latency', max: 5000 },
    ],
    concurrency: 2,
    retries: 0,
    target,
    judge: { provider: judge, model: 'demo' },
  };
}

export interface BotSampleResult {
  evaluation: SavedEvaluation & { id: string };
  target: { id: string; name: string };
  created: boolean;
  providerAdded: boolean;
}

/**
 * Make sure the workspace has the offline demo model (as the reviewer), the mock bot (its file and its MCP server entry), the
 * bot as a saved target and the sample evaluation, each as written here (one that was edited is put back: make your own with
 * Duplicate). Nothing is run here and nothing is sent anywhere.
 */
export function ensureBotSample(store: WorkspaceStore): BotSampleResult {
  const { provider: demo, added: providerAdded } = ensureDemoModel(store);
  writeOwned(store.path(MOCK_FILE), botSampleMockYaml());
  const servers = store.getMcpServers();
  const server = { id: SERVER_ID, name: 'Clinic bot (offline mock)', folder: 'Mocks', transport: 'mock' as const, mockFile: MOCK_FILE };
  const haveServer = servers.find((s) => s.id === SERVER_ID);
  if (!haveServer || haveServer.transport !== 'mock' || haveServer.mockFile !== MOCK_FILE) store.saveMcpServers(haveServer ? servers.map((s) => (s.id === SERVER_ID ? server : s)) : [...servers, server]);
  let targetId: string | undefined;
  try {
    targetId = findRagTarget(store, BOT_SAMPLE_TARGET).id;
  } catch {
    /* not there yet */
  }
  const target = saveRagTarget(store, { id: targetId, name: BOT_SAMPLE_TARGET, target: botSampleTarget() });
  const lib = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY);
  const data = botSampleEvaluation(target.id, demo.id);
  const have = lib.items.find((i) => i.name === BOT_SAMPLE_NAME);
  const item: LibraryItem<SavedEvaluation> = have ? { ...have, data, updatedAt: new Date().toISOString() } : { id: shortId('ev-'), name: BOT_SAMPLE_NAME, data, updatedAt: new Date().toISOString() };
  store.saveLibrary(EVALUATIONS_LIBRARY, { folders: lib.folders, items: have ? lib.items.map((i) => (i === have ? item : i)) : [...lib.items, item] });
  return { evaluation: { ...data, id: item.id }, target, created: !have, providerAdded };
}
