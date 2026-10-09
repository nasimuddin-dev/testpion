import { useCallback, useState, type ReactNode } from 'react';
import { call } from '../api';
import type { Collection, LibraryItem } from '../types';
import { SaveModal } from '../views/rest/dialogs';
import { refreshCollections, useCollectionTree } from './collections-store';

export interface SaveTarget {
  collectionId: string;
  name: string;
  folder?: string;
}

/**
 * Saving a new gRPC call or connection: the same "Save request" dialog as REST asks for its name, collection (or a
 * new one) and folder; every saved request belongs to a collection. `ask` resolves with the choice, or undefined
 * when cancelled; `modal` is rendered by the view.
 */
export function useSaveInCollection(
  items: Array<Pick<LibraryItem, 'folder' | 'collectionId'>>,
  title: string,
): { ask(defaults: { name: string; collectionId?: string; folder?: string }): Promise<SaveTarget | undefined>; modal: ReactNode } {
  const collections = useCollectionTree();
  const [asking, setAsking] = useState<{ name: string; collectionId?: string; folder?: string; resolve(t: SaveTarget | undefined): void }>();
  const ask = useCallback((defaults: { name: string; collectionId?: string; folder?: string }) => new Promise<SaveTarget | undefined>((resolve) => setAsking({ ...defaults, resolve })), []);
  const folderNames = useCallback(
    (collectionId: string) =>
      [...new Set([...items.filter((i) => i.collectionId === collectionId).map((i) => i.folder), asking?.folder].filter((f): f is string => !!f))].sort((a, b) => a.localeCompare(b)),
    [items, asking?.folder],
  );
  const done = (t: SaveTarget | undefined) => {
    asking?.resolve(t);
    setAsking(undefined);
  };
  const modal = asking ? (
    <SaveModal
      title={title}
      collections={collections}
      defaultName={asking.name}
      defaultCollectionId={asking.collectionId}
      defaultFolder={asking.folder}
      folderNames={folderNames}
      onClose={() => done(undefined)}
      onSave={(collectionId, name, folder) => done({ collectionId, name, folder })}
      onCreate={async (c: Collection) => {
        await call('col.save', c);
        await refreshCollections();
      }}
    />
  ) : null;
  return { ask, modal };
}
