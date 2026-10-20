/**
 * The test-file format reference the YAML-writing tasks get (found live: a model put response fields into
 * `assertions:` and repaired by guessing). It is made from the schema and the check registry (a new check type shows up
 * in it), it stays within its token budget, its example is a valid flow, and a check-shape lint error is sent back with
 * the right entry shape and the allowed types — recovered in one repair.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkAliases,
  checksReference,
  checkTypes,
  estimateTokens,
  explainCheckProblem,
  FLOW_EXAMPLE,
  flowFormatReference,
  registerCheck,
  runAiTask,
  verifyTestFile,
} from '../../packages/core/src/index.js';
import { harness, LIVE, printScorecard, score } from './harness.js';

afterAll(printScorecard);

/** The token budgets of the references (they go into every call of those tasks). */
// (+50: the seven RAG metrics are named in the list of other check types; their fields are not in the reference)
// (+60: the retrieval metrics of R1b (recall@k … r-precision, the lexical context metrics, string-similarity, context-relevance) are named too)
const FLOW_BUDGET = 1010;
const CHECKS_BUDGET = 600;

describe('the format reference', () => {
  it('stays within its token budget', () => {
    expect(estimateTokens(flowFormatReference())).toBeLessThanOrEqual(FLOW_BUDGET);
    expect(estimateTokens(checksReference())).toBeLessThanOrEqual(CHECKS_BUDGET);
  });

  it('is made from the check registry: every type is named, and a new one shows up', () => {
    const ref = flowFormatReference();
    const aliases = checkAliases();
    // each type once (its other names, such as http-status, work as well)
    for (const t of checkTypes()) expect(ref).toContain(aliases[t] ?? t);
    expect(aliases['http-status']).toBe('status');
    registerCheck('zz-documented', () => ({ type: 'zz-documented', passed: true, message: 'ok' }) as never, { fields: 'zz: the zz field', example: { type: 'zz-documented', zz: 1 } });
    registerCheck('zz-plain', () => ({ type: 'zz-plain', passed: true, message: 'ok' }) as never);
    const after = checksReference();
    expect(after).toContain('- { type: zz-documented, zz: 1 } — zz: the zz field');
    expect(after).toMatch(/Other types[^\n]*zz-plain/);
  });

  it('has step keys from the schema and an example the lint accepts', async () => {
    const ref = flowFormatReference();
    for (const k of ['dependsOn:', 'extract:', 'body:', 'auth:', 'if:', 'when:']) expect(ref).toContain(`- ${k}`);
    expect(ref).toContain('Checks (assertions:)');
    expect(ref).toContain('{ type: status, expected: 201 }');
    expect((await verifyTestFile(FLOW_EXAMPLE, 'ai/example.yaml')).status).toBe('pass');
  });

  it('explains a check without a type, or with an unknown one, with the right shape', () => {
    const e = explainCheckProblem('line 28: Unknown check type "Dog": allowed-tools, answer-correctness, contains');
    expect(e).toMatch(/^line 28: Unknown check type "Dog" — likely cause: each entry of assertions: is one check map with a type/);
    expect(e).toContain('{ type: status, expected: 201 }');
    expect(e).toContain('Types for a response: status, exists');
    expect(explainCheckProblem('line 3: something else')).toBe('line 3: something else');
  });
});

const WRONG_SHAPE = `name: Pets
tests:
  - id: create-pet
    type: http
    method: POST
    url: "{{baseUrl}}/pets"
    extract:
      petId: $.id
    assertions:
      - status: 201
      - name: Rex
      - type: Dog
  - id: get-pet
    type: http
    method: GET
    url: "{{baseUrl}}/pets/{{petId}}"
    dependsOn: [create-pet]
    assertions:
      - { type: status, expected: 200 }
`;

describe('design-flow writes the right check shapes (mock provider unless AI_EVAL_LIVE=1)', () => {
  it('the instruction carries the reference; a wrong assertions shape is repaired in exactly one turn', async () => {
    if (LIVE) return;
    const h = harness({ rules: [{ match: '.', responses: [`\`\`\`yaml\n${WRONG_SHAPE}\`\`\``, `\`\`\`yaml\n${FLOW_EXAMPLE}\`\`\``] }] });
    try {
      const r = await runAiTask(h.deps, { task: 'design-flow', question: 'create a pet then read it back' });
      expect(h.rec.requests[0]!.messages[0]!.content).toContain('TestPion test file format (YAML)');
      expect(r.repairs).toBe(1);
      expect(r.problems).toEqual([]);
      const repair = h.rec.requests[1]!.messages.at(-1)!.content;
      expect(repair).toContain('likely cause: each entry of assertions: is one check map with a type');
      expect(repair).toContain('{ type: status, expected: 201 }');
    } finally {
      h.cleanup();
    }
  });

  it('design-flow: assertions shape (create then read with status and json-path checks; live: at most one repair)', async () => {
    const h = harness({
      rules: [{ match: '.', response: `\`\`\`yaml\n${FLOW_EXAMPLE.replace('{ type: equals, path: $.name, expected: Rex }', '{ type: json-path, path: $.name, expected: Rex }')}\`\`\`` }],
    });
    try {
      const r = await runAiTask(h.deps, {
        task: 'design-flow',
        question: 'create a pet (POST {{baseUrl}}/pets), then read it back by its id; check the status of both and the name with a json-path check',
      });
      const item = r.proposal?.items[0];
      const ok = !!item && item.verification.every((b) => b.status !== 'fail') && r.repairs <= 1;
      score('design-flow', 'assertions shape', r, ok);
      expect(ok).toBe(true);
      if (!LIVE) expect(r.repairs).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});
