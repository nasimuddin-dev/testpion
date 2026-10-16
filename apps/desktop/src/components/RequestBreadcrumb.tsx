import { LinkButton, type MenuItem } from './ui';
import { RowMenu } from './TreeParts';
import { useCollectionTree } from '../lib/collections-store';
import type { CollectionNode } from '../types';
import { ItemBreadcrumb, type Crumb } from './ItemBreadcrumb';

/** The folders from a collection's top level down to a request (empty at the top level). */
function folderPath(nodes: CollectionNode[], id: string): Array<{ id: string; name: string }> | undefined {
  for (const n of nodes) {
    if (n.id === id) return [];
    if (n.kind === 'folder') {
      const inner = folderPath(n.items, id);
      if (inner) return [{ id: n.id, name: n.name }, ...inner];
    }
  }
  return undefined;
}

/**
 * Where the open request lives — *Collection › Folder › Request*, like Postman — above every request
 * editor (REST, GraphQL, gRPC, WebSocket); or that it isn't saved yet, with Save.
 * A collection request is found by `requestId`; a gRPC call or connection gives its `folder`.
 */
export function RequestBreadcrumb({ collectionId, requestId, folder, name, dirty, onSave, actions }: { collectionId?: string; requestId?: string; folder?: string; name: string; dirty?: boolean; onSave?(): void; actions?: MenuItem[] }) {
  const collections = useCollectionTree();
  const c = collectionId ? collections.find((x) => x.id === collectionId) : undefined;
  // a saved gRPC call or connection names its folder (no id: a segment that only says where)
  const path: Crumb[] | undefined = c
    ? (requestId ? folderPath(c.items, requestId)?.map((f) => ({ label: f.name, reveal: { kind: 'folder' as const, collectionId: c.id, folderId: f.id } })) : undefined) ??
      (folder ? [{ label: folder }] : requestId ? undefined : [])
    : undefined;
  // the request's own actions (Save as test …), the same ⋯ as a row of the tree, at the line's end
  const more = actions?.length ? (
    <span className="ml-auto shrink-0" data-tour="request-more">
      <RowMenu label={name} items={actions} header />
    </span>
  ) : null;
  if (!c || !path)
    return (
      <div className="flex items-center gap-1.5 px-3 pt-1.5 text-xs text-muted min-w-0" data-tour="request-line">
        <span className="truncate">{collectionId && !collections.length ? '' : 'Not saved in a collection'}</span>
        {onSave && (!collectionId || collections.length > 0) && (
          <LinkButton className="shrink-0" onClick={onSave} data-tour="save">
            Save (Ctrl+S)
          </LinkButton>
        )}
        {more}
      </div>
    );
  return (
    <ItemBreadcrumb
      label="Where this request is saved"
      crumbs={[{ label: c.name, ref: { kind: 'collection', collectionId: c.id }, title: 'Collection settings, runner and docs' }, ...path]}
      name={name}
      dirty={dirty}
      actions={actions}
    />
  );
}
