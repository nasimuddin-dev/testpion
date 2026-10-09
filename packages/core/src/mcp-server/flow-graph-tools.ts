import { flowGraph } from '@testpion/shared';
import { editFlowFile, type FlowEditOp } from '../runner/flow-edit.js';
import { flowOfFile, flowReport } from '../runner/flow-steps.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { str, type Tool } from './tool.js';

/**
 * MCP tools that read a test file as a flow (its steps, what each extracts and waits for, the layout in columns and
 * the latest run's result per step: what the app's Flow tab and `testpion flow` show) and edit it the way the app's
 * flow designer does (`testpion flow edit`): add, connect, disconnect, change and remove steps. An edit keeps the
 * file's comments, key order and line endings.
 */
export function flowGraphTools({ store }: { store: WorkspaceStore }): Tool[] {
  const file = str('The test file inside tests/, e.g. rest/checkout-flow.yaml');
  /** Apply an edit and answer what an agent needs next: the steps after it, the edges and any problem. */
  const edit = (a: Record<string, unknown>, op: FlowEditOp) => {
    const r = editFlowFile(store, String(a.file ?? ''), op);
    const g = flowGraph(r.steps);
    return { file: r.file, written: r.written, ...(r.added ? { added: r.added } : {}), steps: r.steps, edges: g.edges, problems: g.problems };
  };
  const position = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Where the step goes on the canvas: [x, y] (optional; the app lays out the others)' };
  return [
    {
      name: 'flow_graph',
      description:
        "A test file as a flow diagram: its steps (id, name, type, method and URL for HTTP, the names it extracts, dependsOn), the edges between them, the steps in columns (layers: what can run first, what waits), problems (a dependency nobody defines, a cycle), the latest run that included the file with each step's status and duration, and the diagram as Graphviz DOT. Use it to read or explain an integration flow before changing it with flow_add_step, flow_connect, flow_update_step or flow_remove_step.",
      inputSchema: { type: 'object', properties: { file: str('The test file inside tests/, e.g. rest/patient-lifecycle.yaml') }, required: ['file'] },
      run: async (a) => flowReport(await flowOfFile(store, String(a.file ?? ''))),
    },
    {
      name: 'flow_add_step',
      description:
        'Add a step to a flow (a test file; an empty one works: name: X, tests: []). Give `step` as a test is written (name, type: http | graphql | grpc | websocket | mcp | llm | delay, method, url, headers, body, extract: { token: "$.access_token" }, assertions …; a pause is { name, type: delay, ms: 2000 }), or `steps` (with chain: true each waits for the one before), or `collection` and `items` (saved requests or folders by id or name, added in order and chained, with extracts suggested from saved examples). With `after`, the new step waits for that step (dependsOn). Answers the steps after the edit and the ids added.',
      write: true,
      inputSchema: {
        type: 'object',
        properties: {
          file,
          step: { type: 'object', description: 'One step: { name, type, method, url, … } as in a test file; a delay is { name, type: delay, ms } (0 to 600000)', additionalProperties: true },
          steps: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Several steps, in order' },
          chain: { type: 'boolean', description: 'With steps or collection: each step waits for the one before it (default true for a collection)' },
          collection: str('Add saved requests of this collection (id or name) instead of step(s)'),
          items: { type: 'array', items: { type: 'string' }, description: 'With collection: requests or folders (id or name); left out, every request of the collection' },
          after: str('The id (or name) of the step the new one waits for; it is put right after it'),
          at: position,
        },
        required: ['file'],
      },
      run: (a) => {
        const at = Array.isArray(a.at) ? (a.at as [number, number]) : undefined;
        const after = a.after ? String(a.after) : undefined;
        if (a.collection) return edit(a, { op: 'addFromCollection', collection: String(a.collection), items: Array.isArray(a.items) ? a.items.map(String) : undefined, after, at, chain: a.chain === undefined ? true : !!a.chain });
        if (Array.isArray(a.steps)) return edit(a, { op: 'addSteps', steps: a.steps as Record<string, unknown>[], after, at, chain: !!a.chain });
        return edit(a, { op: 'addStep', step: (a.step ?? {}) as Record<string, unknown>, after, at });
      },
    },
    {
      name: 'flow_connect',
      description: 'Make step `to` wait for step `from` in a flow (adds `from` to its dependsOn; values `from` extracts are then available to `to` as {{name}}). Refused when it would make a cycle.',
      write: true,
      inputSchema: { type: 'object', properties: { file, from: str('The step that runs first (id or name)'), to: str('The step that waits for it (id or name)') }, required: ['file', 'from', 'to'] },
      run: (a) => edit(a, { op: 'connect', from: String(a.from ?? ''), to: String(a.to ?? '') }),
    },
    {
      name: 'flow_disconnect',
      description: 'Step `to` no longer waits for step `from` (removes `from` from its dependsOn).',
      write: true,
      inputSchema: { type: 'object', properties: { file, from: str('The step it waited for (id or name)'), to: str('The step that waited (id or name)') }, required: ['file', 'from', 'to'] },
      run: (a) => edit(a, { op: 'disconnect', from: String(a.from ?? ''), to: String(a.to ?? '') }),
    },
    {
      name: 'flow_update_step',
      description:
        'Change keys of one step of a flow: `set` is { key: value } as in a test file (url, method, headers, body, extract, assertions, …); null removes a key. name and id rename the step (every dependsOn that names it follows); dependsOn replaces what it waits for (a cycle is refused). Other keys and comments stay.',
      write: true,
      inputSchema: {
        type: 'object',
        properties: { file, id: str('The step (id or name)'), set: { type: 'object', additionalProperties: true, description: '{ key: value } to set; null removes the key' } },
        required: ['file', 'id', 'set'],
      },
      run: (a) => edit(a, { op: 'updateStep', id: String(a.id ?? ''), set: (a.set ?? {}) as Record<string, unknown> }),
    },
    {
      name: 'flow_remove_step',
      description: 'Remove steps from a flow; the steps that waited for them no longer do (their dependsOn is cleaned) and their place on the canvas goes too.',
      write: true,
      inputSchema: {
        type: 'object',
        properties: { file, id: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'The step, or several (id or name)' } },
        required: ['file', 'id'],
      },
      run: (a) => edit(a, { op: 'removeStep', id: Array.isArray(a.id) ? a.id.map(String) : String(a.id ?? '') }),
    },
  ];
}
