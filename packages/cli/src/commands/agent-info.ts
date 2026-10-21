import { Command } from 'commander';
import { AGENT_ENVIRONMENT, agentCommands, agentMcp, ENGINE_VERSION, EXIT_CODES } from '@testpion/core';
import { withWorkspace, WORKSPACE_OPTION } from '../shared.js';

/**
 * `testpion agent-info`: what an AI agent needs to drive TestPion from this machine, as one JSON object — the version,
 * the workspace it would get, the commands and their exit codes, the environment variables, the MCP server setup and
 * where the docs for agents are. Agents read it instead of guessing from --help.
 */
export function registerAgentInfoCommand(program: Command): void {
  program
    .command('agent-info')
    .description('what an AI agent needs to use TestPion here, as JSON: the workspace, the commands and exit codes, environment variables, the MCP server setup, the docs for agents')
    .option(...WORKSPACE_OPTION)
    .action(async (o: { workspace?: string }) => {
      let workspace: Record<string, unknown> | null = null;
      try {
        workspace = await withWorkspace(o.workspace, (store) => ({
          name: store.workspace.name,
          root: store.root,
          collections: store.listCollections().map((c) => c.name),
          environments: store.listEnvironments().map((e) => e.name),
          folders: { tests: 'tests/ (YAML test files and *.suite.yaml)', specs: 'specs/ (OpenAPI, AsyncAPI)', datasets: 'datasets/', mocks: 'mocks/', collections: 'collections/' },
        }));
      } catch {
        workspace = null;
      }
      const w = workspace ? ` -w "${String(workspace.root)}"` : '';
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            testpion: ENGINE_VERSION,
            workspace,
            // one source with AGENTS.md (testpion agents init): the same commands, exit codes and MCP setup
            commands: agentCommands(w),
            exitCodes: EXIT_CODES,
            output: { json: '--json prints one envelope { schema_version, command, status: ok | failed | error, data, errors: [{ code, message, hint, retryable }], warnings, metrics }: read .data; --jsonl streams runs and servers a line per event; --dry-run on commands that write; -r json on runs writes results.jsonl, summary.json and report.json into -o', logs: 'stderr; results go to stdout' },
            environment: AGENT_ENVIRONMENT,
            mcp: agentMcp(`testpion mcp-server${w}`),
            docs: { agents: 'https://testpion.dev/ai-testing/mcp-server', llms: 'https://testpion.dev/llms.txt', agentsMd: `testpion agents init${w} [--targets agents,claude,cursor] writes AGENTS.md (and CLAUDE.md, a Cursor rule) into the workspace` },
            secrets: 'Secret values never appear in tool results, exports or generated files: they are {{variables}}; set them in the environment or the app.',
          },
          null,
          2,
        ),
      );
    });
}
