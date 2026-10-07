import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { lintTestFile, normalizeTest, testsFromSpec, writeTestsFromSpec, WorkspaceStore } from '../../packages/core/src/index.js';

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
