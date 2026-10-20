import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { editFlowFile, flowOfFile, loadTestsFromFile, WorkspaceManager, type WorkspaceStore } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// B-07: a dataset-driven test file (one template, one test per record when it runs) is ONE step on the Flow canvas,
// and every canvas edit writes to that step; the flow used to list one step per record, ids no edit could find.
const T = tempDir('tp-flow-dataset-');
let store: WorkspaceStore;

const TEMPLATE = `# One test per dataset row
name: Intent classification
type: http
method: GET
url: "{{baseUrl}}/intent?q={{message}}"
dataset:
  path: ../datasets/intents.jsonl
assertions:
  - type: status
    expected: 200
`;

const testsDir = () => store.path('tests');

beforeAll(() => {
  store = new WorkspaceManager(join(T.dir, 'home')).create('flow-dataset', join(T.dir, 'ws'));
  mkdirSync(join(testsDir(), 'ai'), { recursive: true });
  mkdirSync(join(testsDir(), 'datasets'), { recursive: true });
  // a dataset path is relative to the test file: tests/ai/x.yaml reads tests/datasets/intents.jsonl
  writeFileSync(join(testsDir(), 'datasets', 'intents.jsonl'), ['{"id":"a","message":"hi"}', '{"id":"b","message":"bye"}', '{"id":"c","message":"hey"}'].join('\n') + '\n');
  writeFileSync(join(testsDir(), 'ai', 'intents.yaml'), TEMPLATE);
  writeFileSync(
    join(testsDir(), 'ai', 'listed.yaml'),
    'name: Listed\ntests:\n  - id: rows\n    name: Rows\n    type: http\n    url: "{{baseUrl}}/r/{{message}}"\n    dataset:\n      path: ../datasets/intents.jsonl\n  - id: after\n    name: After\n    type: http\n    url: "{{baseUrl}}/after"\n    dependsOn: [rows]\n',
  );
});
afterAll(() => {
  store.close();
  T.cleanup();
});

describe('a dataset-driven test file in the Flow view', () => {
  it('shows the template as one step, labelled with its dataset, while a run still gets one test per row', async () => {
    const flow = await flowOfFile(store, 'ai/intents.yaml', { raw: true });
    expect(flow.steps).toHaveLength(1);
    expect(flow.steps[0]!.id).toBe('intents:intent-classification');
    expect(flow.steps[0]!.loop).toBe('× each row of ../datasets/intents.jsonl');
    const rows: string[] = [];
    for await (const t of loadTestsFromFile(join(testsDir(), 'ai', 'intents.yaml'))) rows.push(t.id);
    expect(rows).toEqual(['intent-classification:a', 'intent-classification:b', 'intent-classification:c']);
  });

  it('every canvas edit finds the step by the id the flow gave it, and keeps the dataset', async () => {
    const id = (await flowOfFile(store, 'ai/intents.yaml')).steps[0]!.id;
    editFlowFile(store, 'ai/intents.yaml', { op: 'setLayout', positions: { [id]: [120, 40] } });
    editFlowFile(store, 'ai/intents.yaml', { op: 'updateStep', id, set: { method: 'POST' } });
    const added = editFlowFile(store, 'ai/intents.yaml', { op: 'addStep', step: { name: 'Summary', type: 'http', url: '{{baseUrl}}/summary' }, after: id });
    // the step that is waited for is given the id the edit named it by
    expect(added.steps.map((s) => s.id)).toEqual(['intent-classification', 'summary']);
    const flow = await flowOfFile(store, 'ai/intents.yaml', { raw: true });
    expect(flow.steps.map((s) => s.id)).toEqual(['intent-classification', 'summary']);
    expect(flow.steps[0]!.position).toEqual([120, 40]);
    expect(flow.steps[0]!.loop).toContain('× each row of');
    const written = parse(readFileSync(join(testsDir(), 'ai', 'intents.yaml'), 'utf8'));
    expect(written.tests[0]).toMatchObject({ name: 'Intent classification', method: 'POST', dataset: { path: '../datasets/intents.jsonl' } });
    // the file still runs once per row, and the new step once
    const run: string[] = [];
    for await (const t of loadTestsFromFile(join(testsDir(), 'ai', 'intents.yaml'))) run.push(t.id);
    expect(run).toEqual(['intent-classification:a', 'intent-classification:b', 'intent-classification:c', 'summary']);
  });

  it('a dataset step inside a tests: list is one step, and its neighbours stay connected', async () => {
    const flow = await flowOfFile(store, 'ai/listed.yaml');
    expect(flow.steps.map((s) => s.id)).toEqual(['rows', 'after']);
    expect(flow.steps[0]!.loop).toContain('intents.jsonl');
    editFlowFile(store, 'ai/listed.yaml', { op: 'updateStep', id: 'rows', set: { name: 'Each intent' } });
    const r = editFlowFile(store, 'ai/listed.yaml', { op: 'removeStep', id: 'rows' });
    expect(r.steps.map((s) => s.id)).toEqual(['after']);
  });
});
