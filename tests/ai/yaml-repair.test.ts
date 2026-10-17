/**
 * YAML that models write (found live: `url: {{baseUrl}}/pets` unquoted, repeated through both repairs): the shared
 * normaliser quotes `{{…}}` values before verification, and a YAML error sent back for repair says its likely cause.
 * Also: a test that reads the response time is only proven when the response has one.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { explainYamlError, quoteTemplateValues, runAiTask, verifyScript } from '../../packages/core/src/index.js';
import { harness, LIVE, printScorecard, score } from './harness.js';

afterAll(printScorecard);

const UNQUOTED = `name: Pets
tests:
  - id: create-pet
    type: http
    method: POST
    url: {{baseUrl}}/pets # the collection
    headers:
      Authorization: {{token}}
    extract:
      petId: $.id
    assertions:
      - { type: status, expected: 201 }
  - id: get-pet
    type: http
    method: GET
    url: {{baseUrl}}/pets/{{petId}}
    dependsOn: [create-pet]
    assertions:
      - type: equals
        path: $.id
        expected: {{petId}}
`;

describe('quoteTemplateValues', () => {
  it('quotes plain values that start with {{, keeps comments, and is idempotent', () => {
    const r = quoteTemplateValues(UNQUOTED);
    expect(r.fixed).toBe(4);
    expect(r.text).toContain('url: "{{baseUrl}}/pets" # the collection');
    expect(r.text).toContain('Authorization: "{{token}}"');
    expect(r.text).toContain('expected: "{{petId}}"');
    expect(quoteTemplateValues(r.text)).toEqual({ text: r.text, fixed: 0 });
  });

  it('never touches quoted values, flow maps, block scalars or list items that are not templates', () => {
    const text = `a: "{{x}}"\nb: '{{y}}'\nc: { type: status }\nscript: |\n  url: {{not.yaml}}\n  more\nd:\n  - {{z}}\n  - plain\n`;
    const r = quoteTemplateValues(text);
    expect(r.fixed).toBe(1);
    expect(r.text).toBe(`a: "{{x}}"\nb: '{{y}}'\nc: { type: status }\nscript: |\n  url: {{not.yaml}}\n  more\nd:\n  - "{{z}}"\n  - plain\n`);
  });

  it('explains known YAML errors in plain words', () => {
    expect(explainYamlError('line 2: Unexpected scalar at node end at line 2, column 21', 'a: 1\nurl: {{baseUrl}}/x')).toMatch(/must be in double quotes/);
    expect(explainYamlError('line 3: Map keys must be unique', 'x')).toMatch(/a key appears twice/);
    expect(explainYamlError('line 1: Tabs are not allowed as indentation', '\tx: 1')).toMatch(/spaces only/);
    expect(explainYamlError('something else')).toBe('something else');
  });
});

describe('design-flow with the YAML models write (mock provider unless AI_EVAL_LIVE=1)', () => {
  it('unquoted {{…}} values are fixed before verification: no repair call, and the proposal says so', async () => {
    const h = harness({ rules: [{ match: '.', response: `\`\`\`yaml\n${UNQUOTED}\`\`\`` }] });
    try {
      const r = await runAiTask(h.deps, { task: 'design-flow', question: 'create a pet then read it back', path: 'ai/pets.yaml' });
      const item = r.proposal?.items[0];
      score('design-flow', 'templates quoted', r, !!item && item.verification.every((b) => b.verifier !== 'test-file' || b.status !== 'fail'));
      if (LIVE) return;
      expect(r.calls).toBe(1);
      expect(r.repairs).toBe(0);
      expect(item!.verification[0]).toMatchObject({ verifier: 'test-file', status: 'pass' });
      expect(r.proposal!.notes).toEqual(['Fixed 4 unquoted template values: a YAML value that starts with {{ must be in quotes.']);
      expect(item!.after).toContain('url: "{{baseUrl}}/pets/{{petId}}"');
    } finally {
      h.cleanup();
    }
  });

  it('other broken YAML: the repair message gives the likely cause, and the second answer recovers', async () => {
    if (LIVE) return;
    const duplicate = UNQUOTED.replace('    method: POST\n', '    method: POST\n    method: PUT\n');
    const fixed = quoteTemplateValues(UNQUOTED).text;
    const h = harness({ rules: [{ match: '.', responses: [`\`\`\`yaml\n${duplicate}\`\`\``, `\`\`\`yaml\n${fixed}\`\`\``] }] });
    try {
      const r = await runAiTask(h.deps, { task: 'design-flow', question: 'pets' });
      expect(r.repairs).toBe(1);
      expect(r.problems).toEqual([]);
      expect(h.rec.requests[1]!.messages.at(-1)!.content).toMatch(/likely cause: a key appears twice/);
    } finally {
      h.cleanup();
    }
  });
});

describe('the response time in generated tests', () => {
  it('is proven when the response has a time, and refused with the reason when it has none', async () => {
    const code = "tp.test('fast', () => tp.expect(tp.response.responseTime).to.be.below(1000));";
    const body = JSON.stringify({ ok: true });
    expect(await verifyScript(code, { status: 200, body, latencyMs: 120 })).toMatchObject({ status: 'pass' });
    expect(await verifyScript(code, { status: 200, body })).toMatchObject({ status: 'fail', label: 'reads the response time, which the response it was written for does not have' });
  });
});
