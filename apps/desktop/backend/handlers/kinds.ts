/** RPC handlers: the item-kind registry, and what node menus do to the files of a kind (REG-5, MENU-2). */
import { ApsError, catalogHtml, catalogSite, describeKinds, folderOfWorkspaceFile, itemUses, removeItem, workspaceCatalog, renameSpecFile, duplicateSpecFile, restoreItem } from '@testpion/core';
import { KIND_INFO, type KindId } from '@testpion/shared';
import type { Backend, Handlers } from '../backend.js';
import { saveText } from './save-text.js';

/** An item of a kind left or came back: the views that list the kind reload (a library's list by its file). */
export function itemChanged(be: Backend, kind: KindId): void {
  const info = KIND_INFO[kind];
  if (!info || info.watch === 'none') return;
  be.host.emit('data.changed', { kind: info.watch.legacy, ...(info.library ? { paths: [`library/${info.library}.json`] } : {}) });
}

export function kindHandlers(be: Backend): Handlers {
  return {
    /**
     * Every kind and what it offers (the window reads the static half from @testpion/shared directly: no round trip for
     * a menu); here with the open workspace's facts: whether it is a git repository, which libraries it has.
     */
    'kinds.list': ({ kind, all }: { kind?: string; all?: boolean } = {}) => describeKinds({ kind, all }, be.ws),
    /**
     * Delete any item to Recently deleted by its ref (the kind's `ops` facet: the same function as `testpion item delete`
     * and MCP delete_item); the answer's trashId is what `item.restore` takes (the Undo). The watcher kind of the change
     * is reported so the views reload.
     */
    'item.remove': ({ ref }: { ref: unknown }) => {
      const r = removeItem(be.ws, ref);
      itemChanged(be, r.kind);
      return r;
    },
    /** Put back a deleted item (`item.remove`'s trashId, or an entry of `trash.list`), through the kind's `ops` facet. */
    'item.restore': ({ trashId }: { trashId: string }) => {
      const r = restoreItem(be.ws, trashId);
      itemChanged(be, r.kind);
      return r;
    },
    /** What an item uses and what uses it (read only: the reading of "Export with everything it uses"). */
    'item.uses': ({ ref }: { ref: unknown }) => itemUses(be.ws, ref),
    /** The API catalog: every API with what belongs to it (report/catalog.ts; read only). */
    'catalog.get': () => workspaceCatalog(be.ws),
    /** The catalog as a site (index.html, catalog.json, a documentation page per API), as files for the window to save in a folder the person picks. */
    'catalog.site': async () => (await catalogSite(be.ws)).files,
    /** Save the catalog as one HTML page (the save dialog, or a download where there is none). */
    'catalog.saveHtml': async () => saveText(be, 'api-catalog.html', [{ name: 'HTML', extensions: ['html'] }], catalogHtml(await workspaceCatalog(be.ws), { links: false }), 'text/html'),
    /** Reveal file: the folder that holds a workspace file, in the file manager (the file itself is never opened: it could be a program). */
    'workspace.revealFile': ({ path }: { path: string }) => {
      if (!be.host.openPath) throw new ApsError('ConfigurationError', 'Showing files is not available here (TestPion in a browser)', { suggestions: ['Copy path instead.'] });
      return be.host.openPath(folderOfWorkspaceFile(be.ws, path));
    },
    /** Rename an API definition in specs/ (its virtual folder goes with it); never overwrites. */
    'openapi.spec.rename': ({ path, to }: { path: string; to: string }) => ({ path: renameSpecFile(be.ws, path, to) }),
    /** Delete an API definition: to Recently deleted (Undo restores it, in its folder), through the kind's `ops` facet. */
    // a copy beside it, or one a shared folder gives as this workspace's own (to change)
    'openapi.spec.duplicate': ({ path }: { path: string }) => ({ path: duplicateSpecFile(be.ws, path) }),
    'openapi.spec.delete': ({ path }: { path: string }) => ({ trashId: removeItem(be.ws, { kind: 'spec', path }).trashId }),
  };
}
