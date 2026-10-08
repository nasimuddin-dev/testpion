import { describe, expect, it } from 'vitest';
import { ApsError, executeHttp, unresolvedHostError, VariableScope } from '../../packages/core/src/index.js';

// A {{variable}} left in a URL's host once variables are filled in: the request is not sent (it could only fail
// with ENOTFOUND {{name}}), and the error names the variable, the defined one it likely meant, and where to set it.
describe('a variable without a value in the host', () => {
  it('names the variable and what it likely meant (another case)', () => {
    const e = unresolvedHostError('{{baseurl}}/users', ['baseUrl', 'token'])!;
    expect(e.kind).toBe('ConfigurationError');
    expect(e.message).toBe('{{baseurl}} has no value');
    expect(e.suggestions[0]).toMatch(/Did you mean \{\{baseUrl\}\}\?/);
    expect(e.details).toEqual({ setup: { variable: 'baseurl', meant: 'baseUrl' } });
  });

  it('suggests a name one or two letters off, and nothing for a name far from any', () => {
    expect(unresolvedHostError('https://{{baseUlr}}/x', ['baseUrl'])!.details).toEqual({ setup: { variable: 'baseUlr', meant: 'baseUrl' } });
    const far = unresolvedHostError('{{host}}/x', ['baseUrl'])!;
    expect(far.details).toEqual({ setup: { variable: 'host' } });
    expect(far.suggestions.join(' ')).not.toMatch(/Did you mean/);
  });

  it('only the scheme and host matter; a resolved URL and dynamic values pass', () => {
    expect(unresolvedHostError('https://api.example.com/{{id}}?q={{q}}')).toBeUndefined();
    expect(unresolvedHostError('https://api.example.com/users')).toBeUndefined();
    expect(unresolvedHostError('http://{{$randomInt}}.example.com/')).toBeUndefined();
    expect(unresolvedHostError('http://{{ host }}:8080/x')!.details).toEqual({ setup: { variable: 'host' } });
  });

  it('is thrown before anything is sent, with the names the scope defines', async () => {
    const scope = new VariableScope();
    scope.setScope('environment', { baseUrl: 'http://127.0.0.1:9' });
    const err = await executeHttp({ method: 'GET', url: '{{baseurl}}/users' }, { variableNames: () => scope.names() }).catch((e) => e);
    expect(err).toBeInstanceOf(ApsError);
    expect((err as ApsError).details).toEqual({ setup: { variable: 'baseurl', meant: 'baseUrl' } });
  });
});
