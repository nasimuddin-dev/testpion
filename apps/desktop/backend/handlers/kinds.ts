/** RPC handlers: the item-kind registry, and what node menus do to the files of a kind (REG-5, MENU-2). */
import { ApsError, describeKinds, folderOfWorkspaceFile, renameSpecFile, trashSpec } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

export function kindHandlers(be: Backend): Handlers {
  return {
    /**
     * Every kind and what it offers (the window reads the static half from @testpion/shared directly: no round trip for
     * a menu); here with the open workspace's facts: whether it is a git repository, which libraries it has.
     */
    'kinds.list': ({ kind, all }: { kind?: string; all?: boolean } = {}) => describeKinds({ kind, all }, be.ws),
    /** Reveal file: the folder that holds a workspace file, in the file manager (the file itself is never opened: it could be a program). */
    'workspace.revealFile': ({ path }: { path: string }) => {
      if (!be.host.openPath) throw new ApsError('ConfigurationError', 'Showing files is not available here (TestPion in a browser)', { suggestions: ['Copy path instead.'] });
      return be.host.openPath(folderOfWorkspaceFile(be.ws, path));
    },
    /** Rename an API definition in specs/ (its virtual folder goes with it); never overwrites. */
    'openapi.spec.rename': ({ path, to }: { path: string; to: string }) => ({ path: renameSpecFile(be.ws, path, to) }),
    /** Delete an API definition: to Recently deleted (Undo restores it, in its folder). */
    'openapi.spec.delete': ({ path }: { path: string }) => ({ trashId: trashSpec(be.ws, path) }),
  };
}
