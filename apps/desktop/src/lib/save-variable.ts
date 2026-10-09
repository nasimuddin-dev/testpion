import { call } from '../api';
import { promptText, useApp } from '../store';
import type { TreeVariable } from '../components/JsonView';

/**
 * "Save to variable…" on a response field (REST and GraphQL): asks for the name, returns the test script
 * with a `tp.environment.set(...)` line added (so the value is refreshed after every send), and sets the
 * variable now. Without an active environment the globals are used. Returns undefined when cancelled.
 */
export async function saveResponseVariable(v: TreeVariable, environment: string | undefined, testScript: string | undefined): Promise<string | undefined> {
  const scope = environment ? 'environment' : 'globals';
  const name = (
    await promptText('Save to variable', {
      message: `After every send, this request's test script stores the field in ${environment ? `the ${environment} environment` : 'the globals'}, so later requests can use {{name}}.`,
      value: v.name,
      okLabel: 'Save',
    })
  )?.trim();
  if (!name) return undefined;
  if (!/^[\w.-]+$/.test(name)) {
    useApp.getState().toast('Use letters, digits, _ . or - in a variable name', 'error');
    return undefined;
  }
  const line = `tp.${scope}.set('${name}', tp.response.json()${v.access});`;
  await call('currentValues.set', { scope, owner: environment ?? '', key: name, value: v.value }).catch(() => undefined);
  useApp.getState().toast(`{{${name}}} is set, and the Scripts tab keeps it up to date after each send. Save the request to keep the script.`, 'success');
  return testScript?.trim() ? `${testScript.trimEnd()}\n${line}` : line;
}
