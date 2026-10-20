import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IMPORTER_SUPPORT, migrationPages, TOOL_FORMATS, scriptTable, MATRIX_FEATURES } from '../../packages/core/src/index.js';
import { IMPORT_FORMATS } from '../../packages/shared/src/import-formats.js';

// The migration guides are generated from the importers' support table: they cannot drift from the code.

const docs = resolve(__dirname, '..', '..', 'docs');

/** Formats that are not one of the tools of the guides (standards, snippets, TestPion's own). */
const NOT_A_TOOL = new Set(['openapi', 'swagger', 'har', 'aps-collection', 'aps-workspace', 'graphql-sdl', 'dotenv', 'wsdl', 'asyncapi', 'http-file', 'arazzo']);

describe('docs/migrate', () => {
  it('has a page for every importer, and the overview', () => {
    for (const s of IMPORTER_SUPPORT) expect(existsSync(join(docs, 'migrate', `${s.id}.md`)), `docs/migrate/${s.id}.md`).toBe(true);
    expect(existsSync(join(docs, 'migrate', 'index.md'))).toBe(true);
    expect(IMPORTER_SUPPORT.map((s) => s.id).sort()).toEqual(['apidog', 'bruno', 'hoppscotch', 'httpie', 'insomnia', 'postman', 'thunder', 'yaak']);
  });
  it('every format a tool\'s importer detects is declared by exactly one importer', () => {
    const tools = Object.keys(IMPORT_FORMATS).filter((f) => !NOT_A_TOOL.has(f));
    for (const f of tools) expect(TOOL_FORMATS.has(f as never), `${f} is in no importer's support table`).toBe(true);
    const all = IMPORTER_SUPPORT.flatMap((s) => s.formats);
    expect(new Set(all).size).toBe(all.length);
    for (const f of all) expect(Object.keys(IMPORT_FORMATS)).toContain(f);
  });
  it('the pages on disk are exactly what is generated (run npm run docs:migrate)', () => {
    for (const p of migrationPages()) {
      const have = readFileSync(join(docs, ...p.path.split('/')), 'utf8').replace(/\r\n/g, '\n');
      expect(have, `docs/${p.path} is out of date: run npm run docs:migrate`).toBe(p.markdown);
    }
  });
  it('each page says how to export, what maps, what changes and what does not, and has its script table', () => {
    for (const s of IMPORTER_SUPPORT) {
      const md = migrationPages().find((p) => p.path === `migrate/${s.id}.md`)!.markdown;
      for (const h of ['## Export from', '## Import into TestPion', '## What comes over', '## What is changed on the way', '## What does not come over', '## Importing again and going back']) expect(md, `${s.id}: ${h}`).toContain(h);
      if (s.scripts) {
        expect(md).toContain('## Scripts');
        expect(scriptTable(s.scripts.table)).toContain('tp.');
      }
      // every capability of the matrix is declared
      for (const f of MATRIX_FEATURES) expect(['yes', 'partly', 'no']).toContain(s.matrix[f]);
    }
  });
  it('the overview links every page and shows the matrix', () => {
    const md = migrationPages()[0]!.markdown;
    for (const s of IMPORTER_SUPPORT) expect(md).toContain(`(/migrate/${s.id})`);
    expect(md).toContain('| Feature |');
  });
  it('the script tables list what the converter does, not what someone remembers', () => {
    expect(scriptTable('bruno')).toContain('`req.setHeader(a, b)` | `tp.request.headers.upsert({ key: a, value: b })`');
    expect(scriptTable('thunder')).toContain('`tc.setVar(a, b)`');
    expect(scriptTable('hoppscotch')).toContain('toBeLevel2xx');
    expect(scriptTable('postman')).toContain('pm.datasets');
  });
});
