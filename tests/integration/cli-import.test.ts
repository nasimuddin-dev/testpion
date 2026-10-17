import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runCliSync, tempDir } from '../helpers.js';
import { WorkspaceStore, trashKindsText } from '../../packages/core/src/index.js';

// `testpion import` says what it did to scripts; the `--keep-pm` hint only where --keep-pm changes anything (Postman,
// Insomnia), never after a Bruno import (bru.* becomes tp.* either way). `testpion trash --help` lists every kind the
// trash keeps (from the trash's own kinds table).
const t = tempDir('tp-cli-import-');
afterAll(() => t.cleanup());
const home = join(t.dir, 'home');
const ws = join(t.dir, 'ws');
WorkspaceStore.create(ws, 'Import').close();
const cli = (...args: string[]) => runCliSync(args, { home, cwd: t.dir });

describe('CLI: import messages', () => {
  it('Bruno: scripts converted to tp.*, without the --keep-pm hint', () => {
    const file = join(t.dir, 'pets.bru');
    writeFileSync(
      file,
      'meta {\n  name: List pets\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://example.test/pets\n  body: none\n  auth: none\n}\n\nscript:pre-request {\n  bru.setVar("start", Date.now());\n}\n',
    );
    const r = cli('import', file, '-w', ws);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/Converted 1 script to tp\.\*/);
    expect(r.out).not.toMatch(/--keep-pm/);
  });

  it('Postman: the --keep-pm hint', () => {
    const file = join(t.dir, 'pets.postman.json');
    const item = {
      name: 'List pets',
      request: { method: 'GET', url: 'https://example.test/pets' },
      event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(200));'] } }],
    };
    writeFileSync(file, JSON.stringify({ info: { _postman_id: 'p1', name: 'Pets', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [item] }));
    const r = cli('import', file, '-w', ws);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/Converted 1 script to tp\.\* \(--keep-pm keeps pm\.\*\)/);
  });
});

describe('CLI: trash --help', () => {
  it('lists every kind the trash keeps', () => {
    const r = cli('trash', '--help');
    expect(r.status, r.err).toBe(0);
    expect(r.out.replace(/\s+/g, ' ')).toContain(`recently deleted ${trashKindsText()} (kept 30 days)`);
    expect(trashKindsText()).toBe('collections, environments, datasets, API definitions and MCP servers');
    // the CLI reference says the same
    expect(readFileSync(resolve('docs', 'cli', 'reference.md'), 'utf8')).toContain(`Recently deleted ${trashKindsText()} (30 days)`);
  });
});
