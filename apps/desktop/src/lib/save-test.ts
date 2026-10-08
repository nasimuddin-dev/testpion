import { call } from '../api';
import { promptText, toastError, useApp } from '../store';
import type { CheckConfig } from '../types';

/**
 * "Save as test": the request in a view as a YAML test file under tests/ (tests/rest, tests/graphql,
 * tests/grpc or tests/websocket), for testpion test and CI. {{variables}} are kept, never resolved.
 */
export async function saveAsTestFile(defaultName: string, source: Record<string, unknown>, assertions?: CheckConfig[]): Promise<void> {
  const name = (await promptText('Save as test', { message: 'Test name', value: defaultName, okLabel: 'Save', detail: 'A YAML test file in the workspace’s tests folder, for the Tests view, testpion test and CI.' }))?.trim();
  if (!name) return;
  try {
    const r = await call<{ path: string }>('tests.saveFrom', { name, source, assertions });
    useApp.getState().toast(`Saved tests/${r.path}. Run it in the Tests view or with testpion test.`, 'success');
  } catch (e) {
    toastError(e);
  }
}
