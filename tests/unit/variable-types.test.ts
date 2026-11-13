import { describe, expect, it } from 'vitest';
import { typedVariableValue, variableTypeProblem } from '@testpion/shared';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { VariableScope, WorkspaceStore, setEnvironmentVariables, workspaceAttention } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

/**
 * Typed variables (shared/variable-types.ts): a variable may be a number, a boolean or JSON instead of text. The file
 * still holds text; the type makes a value that does not fit a reported problem, and gives scripts the real value.
 */
describe('typed variables', () => {
  it('says why a value does not fit its type, and nothing when it fits', () => {
    expect(variableTypeProblem('number', '8080')).toBeUndefined();
    expect(variableTypeProblem('number', ' -1.5e3 ')).toBeUndefined();
    expect(variableTypeProblem('number', 'abc')).toBe('not a number: "abc"');
    expect(variableTypeProblem('number', 'Infinity')).toMatch(/not a number/);
    expect(variableTypeProblem('boolean', 'TRUE')).toBeUndefined();
    expect(variableTypeProblem('boolean', 'yes')).toBe('not true or false: "yes"');
    expect(variableTypeProblem('json', '{"a":[1,2]}')).toBeUndefined();
    expect(variableTypeProblem('json', '{a:1}')).toMatch(/^not valid JSON/);
    expect(variableTypeProblem('json', 'x'.repeat(60) + '{')).toMatch(/^not valid JSON/);
  });

  it('an empty value, a {{reference}} and plain text are never a problem', () => {
    for (const type of ['number', 'boolean', 'json'] as const) {
      expect(variableTypeProblem(type, '')).toBeUndefined();
      expect(variableTypeProblem(type, '{{other}}')).toBeUndefined();
    }
    expect(variableTypeProblem('string', 'anything')).toBeUndefined();
    expect(variableTypeProblem(undefined, 'anything')).toBeUndefined();
  });

  it('gives the real value, and leaves what does not fit as the text it is', () => {
    expect(typedVariableValue('number', '8080')).toBe(8080);
    expect(typedVariableValue('boolean', 'False')).toBe(false);
    expect(typedVariableValue('json', '{"a":[1,2]}')).toEqual({ a: [1, 2] });
    expect(typedVariableValue('number', 'abc')).toBe('abc');
    expect(typedVariableValue('number', '{{port}}')).toBe('{{port}}');
    expect(typedVariableValue('number', '')).toBe('');
    expect(typedVariableValue(undefined, '8080')).toBe('8080');
    // a value a script set is already what it is
    expect(typedVariableValue('number', 12)).toBe(12);
  });

  it('a scope holds the typed value: scripts get it, {{name}} writes it as JSON does', () => {
    const vars = new VariableScope();
    vars.setScope('environment', [
      { key: 'port', value: '8080', valueType: 'number' },
      { key: 'debug', value: 'true', valueType: 'boolean' },
      { key: 'tags', value: '["a","b"]', valueType: 'json' },
      { key: 'name', value: '8080' },
      { key: 'bad', value: 'abc', valueType: 'number' },
      { key: 'off', value: '1', valueType: 'number', enabled: false },
    ]);
    expect(vars.scopeValues('environment')).toEqual({ port: 8080, debug: true, tags: ['a', 'b'], name: '8080', bad: 'abc' });
    expect(vars.resolve('{"port": {{port}}, "debug": {{debug}}, "tags": {{tags}}, "name": "{{name}}"}')).toBe('{"port": 8080, "debug": true, "tags": ["a","b"], "name": "8080"}');
  });

  it('a typed secret is still a secret', () => {
    const vars = new VariableScope();
    vars.setScope('environment', [{ key: 'pin', value: '4711', valueType: 'number', secret: true }]);
    expect(vars.get('pin')).toBe(4711);
    expect(vars.isSecret('pin')).toBe(true);
  });

  it('env set keeps a type, refuses a value that does not fit, and attention reports one typed by hand', async () => {
    const t = tempDir('tp-var-types-', { alias: true });
    const store = WorkspaceStore.create(join(t.dir, 'ws'), 'Types');
    try {
      cpSync(join(__dirname, '..', 'fixtures', 'kinds', 'workspace', 'environments'), store.path('environments'), { recursive: true });
      setEnvironmentVariables(store, 'staging', { port: '8080', label: 'x' }, { types: { port: 'number' } });
      const vars = () => store.getEnvironment('staging')!.variables;
      expect(vars().find((v) => v.key === 'port')).toMatchObject({ value: '8080', valueType: 'number' });
      expect(vars().find((v) => v.key === 'label')).not.toHaveProperty('valueType');
      // the type stays when only the value is set again; a value that does not fit is refused, and nothing is written
      setEnvironmentVariables(store, 'staging', { port: '9090' });
      expect(vars().find((v) => v.key === 'port')).toMatchObject({ value: '9090', valueType: 'number' });
      expect(() => setEnvironmentVariables(store, 'staging', { port: 'abc' })).toThrow(/"port" is a number, and the value is not a number: "abc"/);
      expect(vars().find((v) => v.key === 'port')!.value).toBe('9090');
      // back to text
      setEnvironmentVariables(store, 'staging', { port: 'abc' }, { types: { port: 'string' } });
      expect(vars().find((v) => v.key === 'port')).not.toHaveProperty('valueType');
      expect(() => setEnvironmentVariables(store, 'staging', { a: '1' }, { types: { b: 'number' } })).toThrow(/A type was given for "b" but no value/);
      // a file changed by hand (or by git): the problem is listed, with the variable to open
      const env = store.getEnvironment('staging')!;
      store.saveEnvironment({ ...env, variables: [...env.variables, { key: 'retries', value: 'many', valueType: 'number', enabled: true }, { key: 'off', value: 'x', valueType: 'number', enabled: false }] });
      const found = (await workspaceAttention(store)).filter((i) => /the variable/.test(i.message));
      expect(found.map((i) => i.message)).toEqual(['Environment "Staging": the variable retries is a number but its value is not a number: "many"']);
      expect(found[0]!.ref).toEqual({ kind: 'variable', key: 'retries', environmentId: 'staging' });
    } finally {
      store.close();
      t.cleanup();
    }
  });
});
