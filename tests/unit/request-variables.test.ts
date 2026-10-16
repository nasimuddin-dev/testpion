import { describe, expect, it, vi } from 'vitest';
import { describeVariables } from '../../apps/desktop/backend/var-descriptions';
import { isTemplateBlock, templatedText, templateVariables } from '../../packages/shared/src/index';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
vi.mock('../../apps/desktop/src/api', () => ({ call: async () => [], on: () => () => undefined, asError: (e: unknown) => ({ message: String(e), suggestions: [] }), modKey: 'Ctrl', isMac: false }));
const { namesSetByScripts, requestVariables, undefinedVariables } = await import('../../apps/desktop/src/lib/request-variables');

// The environment switcher's badge: the request's {{variables}} that the active environment, its collection and the
// globals don't define — the same descriptions as the field highlighting and the Info panel (describeVariables).
describe('undefined variables of the request on screen', () => {
  const request = {
    request: { url: '{{baseUrl}}/pets/{{petId}}', headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }], body: '{"id":"{{$guid}}","n":"{{petId}}"}' },
    preRequestScript: "tp.environment.set('token', 'x'); const s = 'Hello {{nobody}}';",
    testScript: 'tp.variables.set("later", 1)',
  };

  it('reduces a request to its variables, each once, and the names its scripts set', () => {
    const v = requestVariables(request);
    expect(v.template).toBe('{{baseUrl}} {{petId}} {{token}} {{$guid}}');
    expect(v.setByScripts.sort()).toEqual(['later', 'token']);
    expect([...namesSetByScripts(request.preRequestScript + request.testScript)].sort()).toEqual(['later', 'token']);
  });

  // the example workspace's "List patients": a visualizer template in its test script is Handlebars, not variables
  it('leaves out {{…}} inside scripts (a visualizer template) and descriptions', () => {
    const listPatients = {
      request: { method: 'GET', url: '{{baseUrl}}/patients', auth: { type: 'inherit' } },
      description: 'Uses {{documented}} in prose',
      testScript:
        'const template = `\n<h3>{{total}} patients</h3>\n<table>\n  {{#each items}}\n    <tr><td>{{id}}</td><td>{{name}}</td></tr>\n  {{else}}<tr><td>none</td></tr>\n  {{/each}}\n</table>`;\npm.visualizer.set(template, pm.response.json());',
    };
    expect(requestVariables(listPatients).template).toBe('{{baseUrl}}');
    expect(templateVariables(templatedText(listPatients))).toEqual(['baseUrl']);
  });

  it('never treats Handlebars blocks as variables, wherever they are', () => {
    expect(templateVariables('{{#each items}}{{id}}{{else}}{{/each}}{{^}}{{> row}}{{! note}}{{#if a}}{{/if}} {{elsewhere}}')).toEqual(['id', 'elsewhere']);
    expect(['#each items', '/each', 'else', 'else if x', '^', '> p', '! c'].every(isTemplateBlock)).toBe(true);
    expect(['elseValue', 'items', '$guid'].some(isTemplateBlock)).toBe(false);
    expect(requestVariables({ request: { body: '{{#each xs}}{{x}}{{/each}}' } }).template).toBe('{{x}}');
  });

  it('counts what has no scope, leaving out dynamic variables and what the scripts set', () => {
    const described = describeVariables({ describe: (n) => (n === 'baseUrl' ? { scope: 'environment', value: 'http://x' } : undefined) }, ['baseUrl', 'petId', 'token', '$guid', 'user.name']);
    expect(described.map((d) => [d.name, d.scope ?? '-'])).toEqual([
      ['baseUrl', 'environment'],
      ['petId', '-'],
      ['token', '-'],
      ['$guid', '-'],
      ['user.name', '-'],
    ]);
    expect(undefinedVariables(described, ['token'])).toEqual(['petId', 'user.name']);
    expect(undefinedVariables(described, ['token', 'user'])).toEqual(['petId']);
  });

  it('masks secrets and cuts long values', () => {
    const d = describeVariables({ describe: (n) => (n === 's' ? { scope: 'environment', value: 'hunter2', secret: true } : { scope: 'globals', value: { a: 'x'.repeat(50) } }) }, ['s', 'o'], 10);
    expect(d).toEqual([
      { name: 's', scope: 'environment', value: '••••••', secret: true },
      { name: 'o', scope: 'globals', value: '{"a":"xxxx', secret: undefined },
    ]);
  });
});
