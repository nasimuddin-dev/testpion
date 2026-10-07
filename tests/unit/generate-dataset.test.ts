import { describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRows, generateValue, generateWorkspaceDataset, readDataset, rowsToCsv, WorkspaceStore } from '../../packages/core/src/index.js';

const patient = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string', maxLength: 30 },
    email: { type: 'string', format: 'email' },
    species: { type: 'string', enum: ['cat', 'dog', 'rabbit'] },
    weight: { type: 'number', minimum: 0.5, maximum: 80 },
    born: { type: 'string', format: 'date' },
    ownerId: { type: 'string', format: 'uuid' },
    vaccinated: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    city: { type: 'string' },
  },
};

describe('generated datasets', () => {
  it('fills each field by its format, enum, range and name', () => {
    const rows = generateRows(patient, 50);
    expect(rows).toHaveLength(50);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 50 }, (_v, i) => i + 1));
    for (const r of rows) {
      expect(r.email).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]+$/i);
      expect(['cat', 'dog', 'rabbit']).toContain(r.species);
      expect(r.weight as number).toBeGreaterThanOrEqual(0.5);
      expect(r.weight as number).toBeLessThanOrEqual(80);
      expect(r.born).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.ownerId).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof r.vaccinated).toBe('boolean');
      expect((r.tags as string[]).length).toBeLessThanOrEqual(2);
      expect(String(r.name).length).toBeLessThanOrEqual(30);
      expect(String(r.city)).not.toBe('');
    }
    // not all alike
    expect(new Set(rows.map((r) => r.email)).size).toBeGreaterThan(10);
    expect(generateValue('lastName', { type: 'string' })).toMatch(/^[A-Z][a-z]+/);
  });

  it('writes CSV with nested values as JSON, quoted when needed', () => {
    expect(rowsToCsv([{ a: 'x, y', b: { c: 1 }, d: 'say "hi"' }, { a: 'z' }])).toBe('a,b,d\n"x, y","{""c"":1}","say ""hi"""\nz,,\n');
    expect(() => generateRows({ type: 'string' }, 3)).toThrow(/needs an object schema/);
  });

  it('into a workspace: from an operation of an API definition, readable as a dataset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-gen-'));
    cpSync('examples/veterinary-workspace/specs', join(dir, 'specs'), { recursive: true });
    const store = WorkspaceStore.create(dir, 'gen');
    try {
      const out = generateWorkspaceDataset(store, { name: 'new-patients', rows: 12, spec: 'specs/veterinary-api.yaml', operation: 'POST /patients' });
      expect(out).toMatchObject({ path: 'datasets/new-patients.csv', rows: 12 });
      expect(out.columns).toContain('name');
      const back: unknown[] = [];
      for await (const r of readDataset({ path: join(dir, out.path) })) back.push(r);
      expect(back).toHaveLength(12);
      expect(() => generateWorkspaceDataset(store, { name: 'new-patients', rows: 2, schema: patient })).toThrow(/already exists/);
      const json = generateWorkspaceDataset(store, { name: '../../escape', rows: 2, schema: JSON.stringify(patient), format: 'json' });
      expect(json.path).toBe('datasets/-..-escape.json');
      expect(JSON.parse(readFileSync(join(dir, json.path), 'utf8'))).toHaveLength(2);
      expect(() => generateWorkspaceDataset(store, { name: 'x', rows: 1, spec: 'specs/veterinary-api.yaml', operation: 'GET /nope' })).toThrow(/No operation "GET \/nope"/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
