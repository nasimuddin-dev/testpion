import { KIND_IDS } from '@testpion/shared';
import { describeKinds } from '../kinds/describe.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { Tool } from './tool.js';

/**
 * The item-kind registry for agents (REG-5): every kind of item a workspace holds and what each one offers (open, link,
 * rename, move, delete with undo, run, monitor, CI, test file, flow …), with the reason when something never applies
 * and the release when it is planned. The same answer as `testpion kinds --json` and the app's RPC `kinds.list`.
 */
export function kindTools({ store }: { store: WorkspaceStore }): Tool[] {
  return [
    {
      name: 'list_kinds',
      description: `The kinds of item a TestPion workspace holds (collections, requests, gRPC calls, connections, environments, test files, API definitions, datasets, MCP servers, prompts, load tests, evaluations, monitors, runs, history …) and, for each, its ItemRef shape, where it is stored, where it opens and its capabilities: true, { na: why it never applies } or { planned: release }. Kinds: ${KIND_IDS.join(', ')}.`,
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'One kind, by id or alias (library:grpc, test-file, history-entry …)' },
          all: { type: 'boolean', description: 'Also the kinds registered ahead of their release' },
        },
      },
      run: (a) => describeKinds({ kind: typeof a.kind === 'string' && a.kind ? a.kind : undefined, all: a.all === true }, store),
    },
  ];
}
