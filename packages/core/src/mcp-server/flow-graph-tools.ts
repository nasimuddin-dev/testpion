import { flowOfFile, flowReport } from '../runner/flow-steps.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { str, type Tool } from './tool.js';

/**
 * MCP tools that read a test file as a flow: its steps, what each extracts and waits for, the layout in columns and
 * the latest run's result per step (the app's Flow tab and `testpion flow` show the same).
 */
export function flowGraphTools({ store }: { store: WorkspaceStore }): Tool[] {
  return [
    {
      name: 'flow_graph',
      description:
        "A test file as a flow diagram: its steps (id, name, type, method and URL for HTTP, the names it extracts, dependsOn), the edges between them, the steps in columns (layers: what can run first, what waits), problems (a dependency nobody defines, a cycle), the latest run that included the file with each step's status and duration, and the diagram as Graphviz DOT. Use it to read or explain an integration flow before changing it with write_test_file.",
      inputSchema: { type: 'object', properties: { file: str('The test file inside tests/, e.g. rest/patient-lifecycle.yaml') }, required: ['file'] },
      run: async (a) => flowReport(await flowOfFile(store, String(a.file ?? ''))),
    },
  ];
}
