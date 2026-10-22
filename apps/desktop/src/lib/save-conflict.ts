import { call, setConflictHandler, type NormalizedError } from '../api';
import { useApp } from '../store';

/**
 * A whole-document save that the backend refused because the file changed outside this window since it was read (a git pull, another
 * window, the command line): the person chooses, and nothing is lost silently. Registered once for the window, so every save of a
 * collection, an environment or a saved-items list gets the same dialog (components/SaveConflictDialog.tsx).
 */
export type ConflictChoice = 'mine' | 'theirs' | 'both' | 'cancel';

export interface SaveConflictRequest {
  /** What was being saved, in words ("Veterinary API"). */
  what: string;
  /** Whether "Open both" is offered (a collection or an environment can be saved as a copy). */
  canKeepBoth: boolean;
  resolve(choice: ConflictChoice): void;
}

const SAVES = new Set(['col.save', 'env.save', 'lib.save']);

type P = Record<string, any>;

/** The parameters of the same save without the version that was read, so it is not refused again. */
function withoutEtag(method: string, params: P): P {
  if (method === 'env.save') return { ...params, env: { ...params.env, etag: undefined } };
  if (method === 'lib.save') return { ...params, library: { ...params.library, etag: undefined } };
  return { ...params, etag: undefined };
}

/** The version on disk now. */
async function theirs(method: string, params: P): Promise<unknown> {
  if (method === 'env.save') return ((await call<P[]>('env.list')) ?? []).find((e) => e.id === params.env?.id);
  if (method === 'lib.save') return call('lib.get', { kind: params.kind });
  return call('col.get', { id: params.id });
}

/** My version saved beside theirs, under a new id and a name that says so. */
async function saveCopy(method: string, params: P): Promise<void> {
  const suffix = Date.now().toString(36);
  if (method === 'env.save')
    await call('env.save', { ...params, env: { ...params.env, id: `${params.env.id}-mine-${suffix}`, name: `${params.env.name} (my changes)`, etag: undefined, isProduction: false } });
  else if (method === 'col.save') await call('col.save', { ...params, id: `${params.id}-mine-${suffix}`, name: `${params.name} (my changes)`, etag: undefined, version: 0 });
}

export function askSaveConflict(what: string, canKeepBoth: boolean): Promise<ConflictChoice> {
  return new Promise((resolve) => {
    useApp.getState().set({
      saveConflict: {
        what,
        canKeepBoth,
        resolve: (c) => {
          useApp.getState().set({ saveConflict: undefined });
          resolve(c);
        },
      },
    });
  });
}

export function installSaveConflict(): void {
  setConflictHandler(async ({ method, params, error }: { method: string; params: unknown; error: NormalizedError }) => {
    if (!SAVES.has(method)) return undefined;
    const p = (params ?? {}) as P;
    const what = String(error.details?.what ?? 'This item');
    const choice = await askSaveConflict(what, method !== 'lib.save');
    if (choice === 'cancel') return undefined;
    if (choice === 'mine') return { params: withoutEtag(method, p) };
    if (choice === 'both') await saveCopy(method, p);
    const result = await theirs(method, p);
    void useApp.getState().refreshWorkspace();
    useApp.getState().toast(choice === 'both' ? `${what}: your version is saved as a copy; the one on disk is open` : `${what}: now showing the version on disk`, 'success');
    return { result };
  });
}

installSaveConflict();
