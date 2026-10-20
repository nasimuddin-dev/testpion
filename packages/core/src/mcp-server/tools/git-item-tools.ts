import { gitChangesByItem } from '../../git/by-item.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { str, type Tool } from '../tool.js';

/**
 * The workspace's uncommitted changes by item (planning/git-everything.md, release A): the rows of the app's Git view,
 * named by what they are ("MCP server Weather", "Dataset users.csv", "Prompt Greeting"), not by file.
 */
export function gitItemTools({ store }: { store: WorkspaceStore }): Tool[] {
  return [
    {
      name: 'git_changes',
      description:
        'What changed since the last commit, item by item, named the way the app names it: "MCP server Weather: URL", "Dataset users.csv: 12 rows added", "API definition petstore.yaml: 1 operation added", "Prompt Greeting: moved, settings", "Kinds API ▸ Pets ▸ List pets: URL". Each row has the registry `kind` (mcp-server, provider, prompt, load-test, evaluation, monitor, grpc-call, ws-connection, request, folder, collection, environment, workspace, test, spec, dataset, script-package, proto, mcp-mock, debugger-rules), the change (added, removed, changed, renamed, conflicted), `details` (what changed, never a secret value), the item\'s `ref` and `link`, and the `file` it is in with whether that file is `staged`. Filter with `kind` (a kind id or its alias). Same rows as the Git view and `testpion git status --by-item --json`.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            description: 'Only these kinds: one name or a list (mcp-server, provider, prompt, dataset, spec, test, environment, collection …)',
            anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          file: str('Only the items in this file (workspace-relative)'),
        },
      },
      run: async (a) => {
        const kinds = a.kind === undefined ? undefined : Array.isArray(a.kind) ? a.kind.map(String) : [String(a.kind)];
        const r = await gitChangesByItem(store.root, { kinds });
        return a.file ? { ...r, items: r.items.filter((i) => i.file === String(a.file)) } : r;
      },
    },
  ];
}
