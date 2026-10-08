import { describe, it, expect, afterAll } from 'vitest';
import { runCliSync } from '../helpers.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `testpion lint-tests`: a path as `testpion test` takes it (tests/ai/rag.yaml, from the workspace folder) or under tests/ (ai/rag.yaml).
const dir = mkdtempSync(join(tmpdir(), 'tp-lint-tests-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
const cli = (...args: string[]) => runCliSync(['lint-tests', ...args], { cwd: dir });

describe('CLI: lint-tests', () => {
  it('takes a path from the workspace folder or under tests/, and knows the RAG checks', () => {
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ name: 'Lint', version: 1 }));
    mkdirSync(join(dir, 'tests', 'ai'), { recursive: true });
    writeFileSync(
      join(dir, 'tests', 'ai', 'rag.yaml'),
      [
        'name: RAG',
        'type: rag',
        'question: When is it open?',
        'contexts: [{ id: d1, text: Open 9am to 5pm. }]',
        'expected: Open 9am to 5pm.',
        'evaluators:',
        '  - type: faithfulness',
        '  - type: context-entity-recall',
        '  - type: answer-correctness',
        '',
      ].join('\n'),
    );
    for (const p of ['tests/ai/rag.yaml', 'ai/rag.yaml', 'tests', '']) {
      const r = cli(...(p ? [p] : []));
      expect(r.status, `${p}: ${r.err}${r.out}`).toBe(0);
      expect(r.out).toMatch(/1 test files, nothing to fix/);
    }
    expect(cli('tests/nope.yaml').err).toMatch(/No such test file or folder/);
  });
});
