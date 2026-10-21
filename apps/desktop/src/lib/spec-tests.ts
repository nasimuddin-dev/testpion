import { call } from '../api';
import { attempt, confirmAction, useApp, type ToastAction } from '../store';

interface Written {
  written: Array<{ path: string; tests: number }>;
  skipped: string[];
}

/**
 * "Generate tests from this definition" for an OpenAPI or AsyncAPI document: asks, writes a test file per tag (or channel)
 * through `openapi.generateTests` (files that exist are kept) and says what was written, with the action `onWritten` offers.
 */
export async function generateTestsFromDefinition(
  spec: string,
  o: { message: string; summary(r: Written, tests: number): string; onWritten(r: Written): ToastAction | undefined },
): Promise<void> {
  const ok = await confirmAction({ title: 'Generate tests from this definition?', message: o.message, confirmLabel: 'Generate tests' });
  if (!ok) return;
  await attempt(async () => {
    const r = await call<Written>('openapi.generateTests', { path: spec });
    const n = r.written.reduce((k, f) => k + f.tests, 0);
    useApp.getState().toast(r.written.length ? o.summary(r, n) : `Every file exists already: ${r.skipped.join(', ')}`, r.written.length ? 'success' : 'warning', r.written.length ? o.onWritten(r) : undefined);
  });
}
