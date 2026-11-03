import { useCallback, useState, type ReactNode } from 'react';
import { call } from '../api';
import type { Collection } from '../types';
import { SaveModal } from '../views/rest/dialogs';
import { refreshCollections, useCollectionTree } from './collections-store';

export interface SaveTarget {
  collectionId: string;
  name: string;
  /** A folder of the collection (any kind of request in any folder); none: its top level. */
  folderId?: string;
}

/**
 * Saving a new gRPC call or connection: the same "Save request" dialog as REST asks for its name, collection (or a
 * new one) and one of its folders (the same folders as its REST requests); every saved request belongs to a collection. `ask` resolves with the choice, or undefined
 * when cancelled; `modal` is rendered by the view.
 */
export function useSaveInCollection(title: string): { ask(defaults: { name: string; collectionId?: string; folderId?: string }): Promise<SaveTarget | undefined>; modal: ReactNode } {
  const collections = useCollectionTree();
  const [asking, setAsking] = useState<{ name: string; collectionId?: string; folderId?: string; resolve(t: SaveTarget | undefined): void }>();
  const ask = useCallback((defaults: { name: string; collectionId?: string; folderId?: string }) => new Promise<SaveTarget | undefined>((resolve) => setAsking({ ...defaults, resolve })), []);
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
      defaultFolder={asking.folderId}
      onClose={() => done(undefined)}
      onSave={(collectionId, name, folderId) => done({ collectionId, name, folderId })}
      onCreate={async (c: Collection) => {
        await call('col.save', c);
        await refreshCollections();
      }}
    />
  ) : null;
  return { ask, modal };
}
