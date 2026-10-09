import { LinkButton } from './ui';
import { ChevronRight } from 'lucide-react';
import { useCollectionTree } from '../lib/collections-store';
import { useApp } from '../store';
import type { CollectionNode } from '../types';

/** The folder names from a collection's top level down to a request (empty at the top level). */
function folderPath(nodes: CollectionNode[], id: string): string[] | undefined {
  for (const n of nodes) {
    if (n.id === id) return [];
    if (n.kind === 'folder') {
      const inner = folderPath(n.items, id);
      if (inner) return [n.name, ...inner];
    }
  }
  return undefined;
}

/**
 * Where the open request lives — *Collection › Folder › Request*, like Postman — above every request
 * editor (REST, GraphQL, gRPC, WebSocket); or that it isn't saved yet, with Save.
 * A collection request is found by `requestId`; a gRPC call or connection gives its `folder`.
 */
export function RequestBreadcrumb({ collectionId, requestId, folder, name, dirty, onSave }: { collectionId?: string; requestId?: string; folder?: string; name: string; dirty?: boolean; onSave?(): void }) {
  const collections = useCollectionTree();
  const c = collectionId ? collections.find((x) => x.id === collectionId) : undefined;
  const path = c ? (requestId ? folderPath(c.items, requestId) : undefined) ?? (folder ? [folder] : requestId ? undefined : []) : undefined;
  if (!c || !path)
    return (
      <div className="flex items-center gap-1.5 px-3 pt-1.5 text-xs text-muted min-w-0">
        <span className="truncate">{collectionId && !collections.length ? '' : 'Not saved in a collection'}</span>
        {onSave && (!collectionId || collections.length > 0) && (
          <LinkButton className="shrink-0" onClick={onSave}>
            Save (Ctrl+S)
          </LinkButton>
        )}
      </div>
    );
  return (
    <nav aria-label="Where this request is saved" className="flex items-center gap-1 px-3 pt-1.5 text-xs text-muted min-w-0">
      <button className="hover:text-fg hover:underline truncate shrink min-w-0" title="Collection settings, runner and docs" onClick={() => useApp.getState().openIntent('collections', { collectionId: c.id })}>
        {c.name}
      </button>
      {path.map((f, i) => (
        <span key={i} className="flex items-center gap-1 min-w-0 shrink">
          <ChevronRight size={11} className="shrink-0" />
          <span className="truncate">{f}</span>
        </span>
      ))}
      <ChevronRight size={11} className="shrink-0" />
      <span className="text-fg truncate">{name}</span>
      {dirty && <span className="shrink-0">· unsaved changes</span>}
    </nav>
  );
}
