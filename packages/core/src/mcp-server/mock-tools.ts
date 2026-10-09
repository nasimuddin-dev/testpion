import { readFileSync } from 'node:fs';
import type { WorkspaceStore } from '../storage/workspace.js';
import { loadMcpMock, mockServeCommands, mockToolsList } from './mcp-mock.js';
import { str, type Tool } from './tool.js';

/**
 * MCP mocks as toolsets: an agent designs the tools of a server that does not exist yet in a `*.mcp-mock.yaml` file
 * (the app's Tools tab does the same), and reads them back from here.
 */
export function mockTools(d: { store: WorkspaceStore }): Tool[] {
  return [
    {
      name: 'mock_tools',
      description:
        'The tools of an MCP mock definition (a *.mcp-mock.yaml file in the workspace, usually under mocks/): name, description, arguments (required ones marked *), input schema and how each answers (text, json, content or a script run on the arguments), plus the commands that serve the file to an agent (stdio and HTTP). A mock is how a toolset is designed before the real server exists; list_mcp_servers shows the mock servers of the workspace with their file.',
      inputSchema: { type: 'object', properties: { file: str('The mock file, relative to the workspace (e.g. mocks/weather.mcp-mock.yaml)') }, required: ['file'] },
      run: (a) => {
        const file = String(a.file ?? '');
        const def = loadMcpMock(readFileSync(d.store.safePath(file), 'utf8'));
        return {
          file,
          name: def.name,
          instructions: def.instructions,
          tools: mockToolsList(def),
          resources: (def.resources ?? []).map((r) => r.uri),
          prompts: (def.prompts ?? []).map((p) => p.name),
          serve: mockServeCommands(file),
        };
      },
    },
  ];
}
