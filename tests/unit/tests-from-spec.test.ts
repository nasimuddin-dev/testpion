import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { importIntoWorkspace, lintTestFile, normalizeTest, testsFromSpec, writeTestsFromSpec, WorkspaceStore } from '../../packages/core/src/index.js';

const vet = readFileSync('examples/veterinary-workspace/specs/veterinary-api.yaml', 'utf8');

describe('tests from an API definition', () => {
  const files = testsFromSpec(vet, { specPath: 'specs/veterinary-api.yaml' });

  it('a file per tag and a suite, each operation with its example and one invalid request', () => {
    expect(files.map((f) => f.path)).toEqual(['tests/veterinary-api/default.yaml', 'tests/veterinary-api/patients.yaml', 'tests/veterinary-api.suite.yaml']);
    const patients = parse(files[1]!.yaml) as { tests: Array<Record<string, any>> };
    expect(patients.tests.map((t) => t.name)).toEqual(['List patients', 'Create a patient', 'Create a patient rejects body "name" left out', 'Get a patient']);
    const create = patients.tests[1]!;
    expect(create).toMatchObject({ method: 'POST', url: '{{baseUrl}}/patients', auth: { type: 'bearer', token: '{{accessToken}}' } });
    expect(create.assertions).toEqual([
      { type: 'status', expected: 201 },
      { type: 'openapi', spec: 'specs/veterinary-api.yaml' },
      { type: 'latency', max: 2000 },
    ]);
    expect(typeof create.body).toBe('object');
    expect(patients.tests[2]!.assertions).toEqual([{ type: 'status', expected: '4xx' }]);
    expect(patients.tests[2]!.body).not.toHaveProperty('name');
    expect(parse(files[2]!.yaml)).toMatchObject({ name: 'Veterinary API (demo)', tests: ['veterinary-api'] });
    expect(files[1]!.yaml.startsWith('# Generated from specs/veterinary-api.yaml')).toBe(true);
  });

  it('the files pass the test-file lint and load in the runner', () => {
    for (const f of files.slice(0, -1)) {
      expect(
        lintTestFile(f.yaml).filter((p) => p.severity === 'error'),
        f.path,
      ).toEqual([]);
      const doc = parse(f.yaml) as { defaults: Record<string, unknown>; tests: Array<Record<string, unknown>> };
      for (const t of doc.tests) expect(normalizeTest({ ...doc.defaults, ...t }).type).toBe('http');
    }
  });

  it('writes into the workspace and keeps files that exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-tfs-'));
    cpSync('examples/veterinary-workspace/specs', join(dir, 'specs'), { recursive: true });
    const store = WorkspaceStore.create(dir, 'tfs');
    try {
      const first = writeTestsFromSpec(store, 'specs/veterinary-api.yaml');
      expect(first.written).toHaveLength(3);
      expect(existsSync(join(dir, 'tests', 'veterinary-api.suite.yaml'))).toBe(true);
      const again = writeTestsFromSpec(store, 'specs/veterinary-api.yaml');
      expect(again).toMatchObject({ written: [], skipped: ['tests/veterinary-api/default.yaml', 'tests/veterinary-api/patients.yaml', 'tests/veterinary-api.suite.yaml'] });
      expect(writeTestsFromSpec(store, 'specs/veterinary-api.yaml', { overwrite: true, negative: false }).written[1]!.tests).toBe(3);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe('tests from an AsyncAPI document', () => {
  const doc = `asyncapi: 3.0.0
info: { title: Kennel, version: '1' }
servers:
  broker: { host: 'localhost:1883', protocol: mqtt }
  kafka: { host: 'localhost:9092', protocol: kafka }
channels:
  temperature:
    address: kennel/{kennel}/temperature
    servers: [{ $ref: '#/servers/broker' }]
    messages: { reading: { payload: { type: object, properties: { celsius: { type: number, example: 21 } } } } }
  events:
    address: kennel.events
    servers: [{ $ref: '#/servers/kafka' }]
    messages: { fed: { payload: { type: object, properties: { pet: { type: string, example: Byron } } } } }
operations:
  reading: { action: receive, channel: { $ref: '#/channels/temperature' } }
  fed: { action: send, channel: { $ref: '#/channels/events' } }
`;

  it('a round trip per channel, checked against the document, with the servers environment', () => {
    const files = testsFromSpec(doc, { specPath: 'specs/asyncapi/kennel.yaml' });
    expect(files.map((f) => f.path)).toEqual(['tests/kennel/channels.yaml', 'tests/kennel.suite.yaml']);
    const t = (parse(files[0]!.yaml) as { tests: Array<Record<string, any>> }).tests;
    expect(t[0]).toMatchObject({ type: 'mqtt', url: '{{brokerUrl}}', subscribe: ['kennel/{{kennel}}/temperature'], send: [{ topic: 'kennel/{{kennel}}/temperature', payload: { celsius: 21 } }] });
    expect(t[1]).toMatchObject({ type: 'kafka', url: '{{kafkaUrl}}', send: [{ topic: 'kennel.events', value: { pet: 'Byron' } }] });
    expect(t[1]!.assertions).toContainEqual({ type: 'asyncapi', spec: 'specs/asyncapi/kennel.yaml' });
    expect(parse(files[1]!.yaml)).toMatchObject({ environment: 'Kennel servers' });
    expect(lintTestFile(files[0]!.yaml).filter((p) => p.severity === 'error')).toEqual([]);
  });

  it('the import keeps the document in specs/asyncapi/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-tfa-'));
    const store = WorkspaceStore.create(dir, 'tfa');
    try {
      const r = importIntoWorkspace(store, doc);
      expect(r.specPath).toBe('specs/asyncapi/kennel.yaml');
      expect(writeTestsFromSpec(store, r.specPath!).written.map((f) => f.path)).toEqual(['tests/kennel/channels.yaml', 'tests/kennel.suite.yaml']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
