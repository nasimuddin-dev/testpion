import { createElement } from 'react';
import { FileCheck2 } from 'lucide-react';
import type { ItemRef } from '@testpion/shared';
import { call } from '../api';
import { promptText, toastError, useApp } from '../store';
import type { CheckConfig } from '../types';
import type { MenuItem } from '../components/ui';
import { openRef, refLabel } from './open-ref';

/**
 * WF-07 "Save as test", the one way, from everywhere: an editor's ⋯ menu (REST, GraphQL, gRPC, WebSocket, an MCP tool
 * call, the AI Playground), the Collections menu (a request; a folder or collection as one file), History and the
 * Debugger. Everything goes through `tests.saveFrom` (core saveTest): a request as an editor holds it (`source`), or an
 * item by its `ref`, read by the backend. Afterwards the toast offers Run now and Open test file. {{variables}} are kept.
 */
export type SaveTestTarget = { ref: ItemRef; name?: string } | { source: Record<string, unknown>; name: string; assertions?: CheckConfig[] };

/** What the item is saved as: one test, or (a folder, a collection) one file with a test per request. */
function isMany(t: SaveTestTarget): boolean {
  return 'ref' in t && (t.ref.kind === 'folder' || t.ref.kind === 'collection');
}

/** The one label of the action, by what it saves. */
export function saveAsTestLabel(t: Pick<SaveTestTarget, never> & { ref?: ItemRef }): string {
  return t.ref?.kind === 'folder' ? 'Create test file from folder…' : t.ref?.kind === 'collection' ? 'Create test file from collection…' : 'Save as test…';
}

/** Run a saved test file now (the active environment; production asks first) and show the run. */
async function runNow(path: string): Promise<void> {
  try {
    const r = await call<{ runId: string }>('tests.run', { paths: [path], environment: useApp.getState().environment, name: path });
    void openRef({ kind: 'run', runId: r.runId });
  } catch (e) {
    toastError(e);
  }
}

/** Ask for the test's name, save it under tests/ and say where, with Run now and Open test file. Resolves to its path. */
export async function saveAsTest(target: SaveTestTarget): Promise<string | undefined> {
  const many = isMany(target);
  const suggested = target.name ?? ('ref' in target ? refLabel(target.ref) : 'Saved test');
  const name = (
    await promptText(many ? 'Create test file' : 'Save as test', {
      message: many ? 'Name of the test file (one test per request)' : 'Test name',
      value: suggested,
      okLabel: 'Save',
      detail: 'A YAML test file in the workspace’s tests folder, for the Tests view, testpion test and CI.',
    })
  )?.trim();
  if (!name) return undefined;
  try {
    const r = await call<{ path: string; tests: number; ref: ItemRef }>('tests.saveFrom', 'ref' in target ? { name, ref: target.ref } : { name, source: target.source, assertions: target.assertions });
    useApp.getState().toast(`Saved tests/${r.path}${r.tests > 1 ? ` (${r.tests} tests)` : ''}`, 'success', [{ label: 'Run now', onClick: () => void runNow(r.path) }, { ref: r.ref }]);
    return r.path;
  } catch (e) {
    toastError(e);
    return undefined;
  }
}

/** The menu item, the same in every menu (its place: the test group, after run). `target` is read when it is chosen. */
export function saveAsTestItem(target: SaveTestTarget | (() => SaveTestTarget | undefined), opts: { disabled?: boolean; separator?: boolean } = {}): MenuItem {
  const peek = typeof target === 'function' ? undefined : target;
  return {
    label: saveAsTestLabel({ ref: peek && 'ref' in peek ? peek.ref : undefined }),
    icon: createElement(FileCheck2, { size: 14 }),
    disabled: opts.disabled,
    separator: opts.separator,
    onSelect: () => {
      const t = typeof target === 'function' ? target() : target;
      if (t) void saveAsTest(t);
    },
  };
}

/** The same item for an editor that saves what it holds itself (its tab menu, its breadcrumb ⋯). */
export function saveAsTestMenuItem(run: (() => void) | undefined, opts: { separator?: boolean } = {}): MenuItem {
  return { label: saveAsTestLabel({}), icon: createElement(FileCheck2, { size: 14 }), disabled: !run, separator: opts.separator, onSelect: () => run?.() };
}

/** An editor's request (REST, GraphQL, gRPC, WebSocket): the same action, from what the editor holds. */
export async function saveAsTestFile(defaultName: string, source: Record<string, unknown>, assertions?: CheckConfig[]): Promise<void> {
  await saveAsTest({ source, name: defaultName, assertions });
}
