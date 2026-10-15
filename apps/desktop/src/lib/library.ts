import { useCallback, useEffect, useMemo, useState } from 'react';
import { asError, call } from '../api';
import { useApp } from '../store';
import type { Library, LibraryItem } from '../types';
import { libraryOps, type FolderListOps } from '../components/FolderList';
import { uid } from './format';

/**
 * Saved items of one kind with folders (WebSocket connections, AI prompts …), stored in the workspace
 * (library/<kind>.json) through lib.get / lib.save. Reloads when the workspace changes.
 */
export function useLibrary<T>(kind: string) {
  const [lib, setLib] = useState<Library<T>>({ folders: [], items: [] });
  const workspace = useApp((s) => s.workspace?.id);
  // resolves to the library read (undefined when it could not be read): an editor following its item on disk compares it
  const reload = useCallback(() => call<Library<T>>('lib.get', { kind }).then((l) => (setLib(l), l), () => undefined), [kind]);
  useEffect(() => {
    void reload();
  }, [reload, workspace]);
  const save = useCallback(
    async (next: Library<T>) => {
      setLib(next);
      try {
        const saved = await call<Library<T> & { warnings?: string[] }>('lib.save', { kind, library: next });
        setLib(saved);
        if (saved.warnings?.length)
          useApp.getState().toast(`Saved, but ${saved.warnings.slice(0, 3).join(', ')}${saved.warnings.length > 3 ? ' …' : ''} holds a secret typed in: it is now in a workspace file. Use a secret {{variable}} instead.`, 'error');
      } catch (e) {
        useApp.getState().toast(`Could not save: ${asError(e).message}`, 'error');
        void reload();
      }
    },
    [kind, reload],
  );
  const ops: FolderListOps = useMemo(() => libraryOps(lib, save, () => uid('lib-')), [lib, save]);
  /** Add or replace an item; returns its id. */
  const put = useCallback(
    async (item: Omit<LibraryItem<T>, 'id'> & { id?: string }) => {
      const id = item.id ?? uid('lib-');
      const next = { ...item, id, updatedAt: new Date().toISOString() } as LibraryItem<T>;
      const exists = lib.items.some((i) => i.id === id);
      await save({ ...lib, items: exists ? lib.items.map((i) => (i.id === id ? next : i)) : [...lib.items, next] });
      return id;
    },
    [lib, save],
  );
  /** An item by id, loading the library first if it isn't known yet (e.g. opened from search). */
  const find = useCallback(
    async (id: string) => lib.items.find((i) => i.id === id) ?? (await call<Library<T>>('lib.get', { kind }).then((l) => (setLib(l), l.items.find((i) => i.id === id)), () => undefined)),
    [lib, kind],
  );
  return { lib, save, ops, put, reload, find };
}
