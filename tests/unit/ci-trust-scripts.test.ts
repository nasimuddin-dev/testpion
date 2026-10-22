import { describe, expect, it } from 'vitest';
import { ciCommand } from '../../packages/core/src/index.js';

describe('CI pipelines and --trust-scripts', () => {
  const shapes = [
    { suite: 'regression' },
    { collection: 'My API' },
    { tests: ['a.yaml'] },
    { tests: ['flow.yaml'], data: '' },
    { ragEvaluation: 'Clinic RAG' },
  ];

  it('is off by default', () => {
    for (const s of shapes) expect(ciCommand(s as never), JSON.stringify(s)).not.toContain('--trust-scripts');
  });

  it('is added right after the sending command when the owner asks for it', () => {
    for (const s of shapes) {
      const c = ciCommand({ ...s, trustScripts: true } as never);
      expect(c, JSON.stringify(s)).toMatch(/testpion (rag run|run-collection|run|test) --trust-scripts /);
      expect(c.match(/--trust-scripts/g)).toHaveLength(1);
    }
  });
});
