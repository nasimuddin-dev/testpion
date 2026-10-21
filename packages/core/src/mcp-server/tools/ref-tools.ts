import { itemRefUrl, parseItemRef, toItemRef, ITEM_KINDS } from '@testpion/shared';
import { resolveItemRef } from '../../storage/item-refs.js';
import { itemInfo } from '../../storage/item-info.js';
import { templateVariables } from '@testpion/shared';
import { WorkspaceSearch } from '../../storage/search.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { ApsError } from '../../errors.js';
import { limitArg, offsetArg, type Tool } from '../tool.js';

/**
 * ItemRefs for agents: the `ref` that results carry (run_tests, recent_failures, what_needs_attention, git_status,
 * debugger_exchanges, search hits) names one thing; resolve_ref says whether it is still there, what it is called, and
 * the testpion:// link that opens it in the app (`testpion open <ref>` does the same from a shell).
 */
export function refTools({ store }: { store: WorkspaceStore }): Tool[] {
  // one index per server, built on first use and refreshed per changed file (the app's Quick Open uses the same search)
  let search: WorkspaceSearch | undefined;
  return [
    {
      name: 'search_workspace',
      description:
        "Find items in the workspace by name or content, like the app's Quick Open (Ctrl+P): requests (by protocol), collections, folders, test files and flows, environments and variables, API definitions, datasets, saved gRPC calls and connections, monitors, MCP servers, history, traces and runs. Each hit has a `ref` (resolve_ref, `testpion open <ref>`).",
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to find' }, limit: { type: 'number', description: 'At most this many hits (default 20, at most 100)' } }, required: ['query'] },
      run: (a) => {
        search ??= new WorkspaceSearch(store);
        // the whole ranked list, cut by the page (the contract asks for one row more than the page)
        const limit = limitArg(a.limit, 20, 501);
        return search.search(String(a.query ?? ''), offsetArg(a.offset) + limit).slice(offsetArg(a.offset));
      },
    },
    {
      name: 'resolve_ref',
      description: `Look up an ItemRef (the \`ref\` field of tool results: {kind, …ids}) in this workspace: whether it still exists, its name and where it is, the link that opens it in the TestPion app (testpion://open?…), or, when it is gone, why and the nearest thing that is still there (\`next\`). Also takes the short form kind:id (request:<collectionId>:<requestId>, run:<runId>, test:<path in tests/>). Kinds: ${ITEM_KINDS.join(', ')}.`,
      inputSchema: {
        type: 'object',
        properties: {
          ref: { description: 'The ItemRef object, its testpion://open link, or the short form kind:id', anyOf: [{ type: 'object' }, { type: 'string' }] },
        },
        required: ['ref'],
      },
      run: (a) => {
        const ref = typeof a.ref === 'string' ? parseItemRef(a.ref) : toItemRef(a.ref);
        if (!ref) throw new ApsError('ValidationError', `Not an ItemRef: give {kind, …ids} with kind one of ${ITEM_KINDS.join(', ')}, a testpion://open link, or kind:id`);
        const r = resolveItemRef(store, ref);
        return r.ok ? { ...r, url: itemRefUrl(r.ref) } : r;
      },
    },
    {
      name: 'item_info',
      description:
        "One item's context, as the app's Info panel shows it: the workspace file that holds it, the {{variables}} it uses, and the latest runs that included it (a test file by the files a run kept, a request or collection by a collection run). Takes a ref like resolve_ref. For a variable's value and where it comes from, use variable_flow or list_environments.",
      inputSchema: { type: 'object', properties: { ref: { description: 'The ItemRef object, its testpion://open link, or the short form kind:id', anyOf: [{ type: 'object' }, { type: 'string' }] } }, required: ['ref'] },
      run: (a) => {
        const ref = typeof a.ref === 'string' ? parseItemRef(a.ref) : toItemRef(a.ref);
        if (!ref) throw new ApsError('ValidationError', `Not an ItemRef: give {kind, …ids} with kind one of ${ITEM_KINDS.join(', ')}, a testpion://open link, or kind:id`);
        const { text, ...info } = itemInfo(store, ref);
        return { ...info, variables: text ? templateVariables(text).slice(0, 200) : [] };
      },
    },
  ];
}
