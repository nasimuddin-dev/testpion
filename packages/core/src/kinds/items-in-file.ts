import type { ItemRef } from '@testpion/shared';
import { restoreFromTrash, trashMcpServer } from '../storage/trash.js';
import { missing, ok } from './ref-index.js';
import type { KindDefs } from './types.js';

/** Kinds kept as a list in one workspace file: MCP servers (mcp-servers.json) and AI providers (providers.json). */
export const itemsInFileKinds: KindDefs = {
  'mcp-server': {
    resolve: (store, ref) => {
      const r = ref as Extract<ItemRef, { kind: 'mcp-server' }>;
      const s = store.getMcpServers().find((x) => x.id === r.serverId);
      return s ? ok(r, s.name, 'MCP server') : missing(r, 'That MCP server is no longer set up in this workspace.', { label: 'Open MCP', view: 'mcp' });
    },
    ops: { remove: (store, id) => trashMcpServer(store, id).trashId, restore: (store, trashId) => restoreFromTrash(store, trashId) },
  },
  provider: {
    resolve: (store, ref) => {
      const r = ref as Extract<ItemRef, { kind: 'provider' }>;
      const p = store.getProviders().find((x) => x.id === r.providerId);
      return p ? ok(r, p.name, 'AI provider') : missing(r, 'That AI provider is no longer set up.', { label: 'Open AI providers', view: 'ai' });
    },
  },
};
